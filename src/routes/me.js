import bcrypt from "bcrypt";
import { Router } from "express";
import multer from "multer";
import { formatEther } from "viem";
import { z } from "zod";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { sendPasswordChangeEmail } from "../lib/mailer.js";
import { consumeOtp, issueOtp } from "../lib/otp.js";
import { publicStorage } from "../lib/storage.js";
import { revokeAllSessions } from "../lib/tokens.js";
import { selectTracks } from "../lib/tracks.js";
import { accountView, findUserById, passwordSchema } from "../lib/users.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter, emailLimiter, uploadLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);

const MY_WALLETS = "SELECT address FROM wallets WHERE user_id = $1";
const eth = (wei) => (wei == null ? null : formatEther(BigInt(wei)));

router.get("/", async (req, res) => {
  const user = await accountView(req.userId);
  if (!user) throw notFound("Account not found", "ACCOUNT_NOT_FOUND");
  res.json({ user });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

router.patch(
  "/",
  validate({ body: z.object({ name: z.string().trim().min(1, "Enter your name").max(100) }) }),
  async (req, res) => {
    await pool.query("UPDATE users SET name = $1 WHERE id = $2", [req.body.name, req.userId]);
    res.json({ user: await accountView(req.userId) });
  }
);

const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/** Replace the profile picture (multipart field "file", up to 5 MB). Profile pictures are public. */
router.put("/avatar", uploadLimiter, avatarUpload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest('Attach the image in a multipart field named "file"');
  if (!AVATAR_TYPES.includes(req.file.mimetype)) {
    throw badRequest("Use a JPEG, PNG, WebP or GIF image", "WRONG_FILE_TYPE");
  }
  const stored = await publicStorage.putFile({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
  });
  await pool.query("INSERT INTO uploads (cid, user_id, kind) VALUES ($1, $2, 'image') ON CONFLICT DO NOTHING", [
    stored.cid,
    req.userId,
  ]);
  await pool.query("UPDATE users SET display_picture_url = $1 WHERE id = $2", [stored.url, req.userId]);
  res.json({ user: await accountView(req.userId) });
});

router.delete("/avatar", async (req, res) => {
  await pool.query("UPDATE users SET display_picture_url = NULL WHERE id = $1", [req.userId]);
  res.json({ user: await accountView(req.userId) });
});

/**
 * Step 1 of a password change: emails a code to the account's address. Accounts that have
 * a password must confirm it first; social sign-ups without one can set one this way.
 */
router.post(
  "/password/code",
  emailLimiter,
  validate({ body: z.object({ currentPassword: z.string().optional() }) }),
  async (req, res) => {
    const user = await findUserById(req.userId);
    if (!user) throw notFound("Account not found", "ACCOUNT_NOT_FOUND");
    if (user.password && !(await bcrypt.compare(req.body.currentPassword ?? "", user.password))) {
      throw badRequest("Your current password is incorrect.", "WRONG_PASSWORD");
    }
    const code = await issueOtp(user.id, "change_password");
    if (!code) {
      return res.json({ sent: false, message: "We sent you a code less than a minute ago. Check your inbox." });
    }
    try {
      await sendPasswordChangeEmail(user, code);
    } catch (err) {
      console.error(`Failed to send change_password email to user ${user.id}:`, err.message);
      throw badRequest("We couldn't send the email. Please try again shortly.", "EMAIL_FAILED");
    }
    res.json({ sent: true, message: `We've sent a 6-digit code to ${user.email}.` });
  }
);

/** Step 2: the emailed code sets the new password and signs out every other device. */
router.post(
  "/password",
  authLimiter,
  validate({
    body: z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), password: passwordSchema }),
  }),
  async (req, res) => {
    if (!(await consumeOtp(req.userId, "change_password", req.body.code))) {
      throw badRequest("That code is invalid or has expired.", "INVALID_CODE");
    }
    const hash = await bcrypt.hash(req.body.password, config.SALTROUNDS);
    await withTransaction(async (client) => {
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hash, req.userId]);
      await revokeAllSessions(req.userId, client, req.sessionId);
    });
    res.json({ message: "Your password has been changed. Other devices have been signed out." });
  }
);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const sumWei = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key] ?? 0), 0n);
const sumCount = (rows, key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

/**
 * Sales of the user's own records and what they've spent, from the indexed chain events
 * of every linked wallet. Amounts are gross (before the marketplace's commission).
 */
router.get("/dashboard", async (req, res) => {
  const params = [req.userId];
  const [catalogue, byTrack, resales, mints, spending, byGenre, recentSales] = await Promise.all([
    pool.query(
      `SELECT (SELECT count(*) FROM playlist WHERE artiste_id = $1)::int AS releases,
              (SELECT count(*) FROM music WHERE artiste_id = $1)::int AS tracks,
              (SELECT count(*) FROM wallets WHERE user_id = $1)::int AS wallets,
              (SELECT count(DISTINCT p.buyer_address)::int FROM purchases p
               JOIN chain_tokens t ON t.token_id = p.token_id
               WHERE t.artiste_address IN (${MY_WALLETS}) AND p.buyer_address NOT IN (${MY_WALLETS})) AS collectors`,
      params
    ),
    // Every sale of the user's records, primary and resale, per track
    pool.query(
      `SELECT m.id AS track_id, coalesce(m.title, 'Token #' || t.token_id) AS title, pl.cover, pl.id AS album_id,
              coalesce(sum(p.amount) FILTER (WHERE p.kind = 'primary'), 0) AS copies_sold,
              coalesce(sum(p.total_price_wei) FILTER (WHERE p.kind = 'primary'), 0) AS sales_wei,
              coalesce(sum(p.amount) FILTER (WHERE p.kind = 'resale'), 0) AS resold_copies,
              coalesce(sum(p.total_price_wei) FILTER (WHERE p.kind = 'resale'), 0) AS resale_volume_wei
       FROM purchases p
       JOIN chain_tokens t ON t.token_id = p.token_id
       LEFT JOIN music m ON m.token_id = t.token_id
       LEFT JOIN playlist pl ON pl.id = m.album_id
       WHERE t.artiste_address IN (${MY_WALLETS})
       GROUP BY t.token_id, m.id, m.title, pl.cover, pl.id
       ORDER BY sales_wei DESC, copies_sold DESC`,
      params
    ),
    // Copies the user resold themselves
    pool.query(
      `SELECT coalesce(sum(amount), 0) AS copies, coalesce(sum(total_price_wei), 0) AS volume_wei
       FROM purchases WHERE kind = 'resale' AND seller_address IN (${MY_WALLETS})`,
      params
    ),
    pool.query(
      `SELECT count(*)::int AS mints, coalesce(sum(fee_wei), 0) AS fees_wei
       FROM chain_mints WHERE artiste_address IN (${MY_WALLETS})`,
      params
    ),
    pool.query(
      `SELECT kind, coalesce(sum(amount), 0) AS copies, coalesce(sum(total_price_wei), 0) AS total_wei
       FROM purchases WHERE buyer_address IN (${MY_WALLETS}) GROUP BY kind`,
      params
    ),
    pool.query(
      `SELECT coalesce(nullif(trim(pl.genre), ''), 'Other') AS genre,
              sum(p.amount) AS copies, sum(p.total_price_wei) AS total_wei
       FROM purchases p
       LEFT JOIN music m ON m.token_id = p.token_id
       LEFT JOIN playlist pl ON pl.id = m.album_id
       WHERE p.buyer_address IN (${MY_WALLETS})
       GROUP BY 1 ORDER BY total_wei DESC`,
      params
    ),
    pool.query(
      `SELECT p.tx_hash, p.log_index, p.kind, p.amount, p.total_price_wei, p.buyer_address, u.name AS buyer_name,
              m.id AS track_id, m.title, pl.cover, pl.id AS album_id
       FROM purchases p
       JOIN chain_tokens t ON t.token_id = p.token_id
       LEFT JOIN music m ON m.token_id = t.token_id
       LEFT JOIN playlist pl ON pl.id = m.album_id
       LEFT JOIN wallets w ON w.address = p.buyer_address
       LEFT JOIN users u ON u.id = w.user_id
       WHERE t.artiste_address IN (${MY_WALLETS})
       ORDER BY p.block_number DESC, p.log_index DESC
       LIMIT 8`,
      params
    ),
  ]);

  const tracks = byTrack.rows;
  const spent = Object.fromEntries(spending.rows.map((row) => [row.kind, row]));
  const mintFees = BigInt(mints.rows[0].fees_wei);
  const primarySpend = BigInt(spent.primary?.total_wei ?? 0);
  const resaleSpend = BigInt(spent.resale?.total_wei ?? 0);

  res.json({
    ...catalogue.rows[0],
    sales: {
      copiesSold: sumCount(tracks, "copies_sold"),
      total: eth(sumWei(tracks, "sales_wei")),
      resoldCopies: sumCount(tracks, "resold_copies"),
      resaleVolume: eth(sumWei(tracks, "resale_volume_wei")),
      byTrack: tracks.map((t) => ({
        track_id: t.track_id,
        title: t.title,
        cover: t.cover,
        album_id: t.album_id,
        copies_sold: Number(t.copies_sold),
        sales: eth(t.sales_wei),
        resold_copies: Number(t.resold_copies),
        resale_volume: eth(t.resale_volume_wei),
      })),
      recent: recentSales.rows.map(({ total_price_wei, ...sale }) => ({ ...sale, total: eth(total_price_wei) })),
    },
    resales: { copies: Number(resales.rows[0].copies), total: eth(resales.rows[0].volume_wei) },
    spending: {
      total: eth(mintFees + primarySpend + resaleSpend),
      minting: { mints: mints.rows[0].mints, total: eth(mintFees) },
      primary: { copies: Number(spent.primary?.copies ?? 0), total: eth(primarySpend) },
      resale: { copies: Number(spent.resale?.copies ?? 0), total: eth(resaleSpend) },
      byGenre: byGenre.rows.map((g) => ({ genre: g.genre, copies: Number(g.copies), total: eth(g.total_wei) })),
    },
  });
});

/** Tracks the user owns in any linked wallet (bought, traded for, or their own artiste copy). */
router.get("/library", async (req, res) => {
  const tracks = await selectTracks({ where: "owned.amount > 0", userId: req.userId, orderBy: "m.album_id DESC, m.id" });
  res.json({ tracks });
});

/** Tracks the user has favourited, most recent first. */
router.get("/favorites", async (req, res) => {
  const tracks = await selectTracks({ where: "f.user_id IS NOT NULL", userId: req.userId, orderBy: "f.created_at DESC" });
  res.json({ tracks });
});

/** Records that a track started playing (full or preview). Repeats within 30s are ignored. */
router.post(
  "/plays",
  validate({ body: z.object({ trackId: z.coerce.number().int().positive(), preview: z.boolean().default(false) }) }),
  async (req, res) => {
    await pool.query(
      `INSERT INTO plays (user_id, music_id, preview)
       SELECT $1, $2, $3
       WHERE EXISTS (SELECT 1 FROM music WHERE id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM plays WHERE user_id = $1 AND music_id = $2 AND played_at > now() - interval '30 seconds'
         )`,
      [req.userId, req.body.trackId, req.body.preview]
    );
    res.status(204).end();
  }
);

/** Recently played tracks across all the user's devices, most recent first. */
router.get("/recent", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT music_id, max(played_at) AS last_played FROM plays WHERE user_id = $1
     GROUP BY music_id ORDER BY last_played DESC LIMIT 50`,
    [req.userId]
  );
  const order = rows.map((r) => r.music_id);
  const tracks = order.length
    ? await selectTracks({ where: "m.id = ANY($2::int[])", params: [order], userId: req.userId })
    : [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  res.json({ tracks: order.map((id) => byId.get(id)).filter(Boolean) });
});

/** Copies the user has listed for resale and not yet sold or cancelled. */
router.get("/listings", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.listing_id, l.token_id, l.amount, l.price_wei, l.seller_address,
            m.id AS track_id, m.title, p.cover, p.title AS album_title, p.id AS album_id
     FROM chain_resale_listings l
     LEFT JOIN music m ON m.token_id = l.token_id
     LEFT JOIN playlist p ON p.id = m.album_id
     WHERE l.active AND l.amount > 0 AND l.seller_address IN (${MY_WALLETS})
     ORDER BY l.listing_id DESC`,
    [req.userId]
  );
  res.json({ listings: rows.map((l) => ({ ...l, price: eth(l.price_wei) })) });
});

/** Trade offers the user made or received, newest first. */
router.get("/trades", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.trade_id, o.status, o.maker_address, o.taker_address,
            o.offered_token_id, o.offered_amount, o.requested_token_id, o.requested_amount,
            (o.taker_address IN (${MY_WALLETS})) AS incoming,
            maker.name AS maker_name, taker.name AS taker_name,
            json_build_object('id', mo.id, 'title', mo.title, 'cover', po.cover, 'album_id', po.id) AS offered_track,
            json_build_object('id', mr.id, 'title', mr.title, 'cover', pr.cover, 'album_id', pr.id) AS requested_track
     FROM chain_trade_offers o
     LEFT JOIN wallets wm ON wm.address = o.maker_address LEFT JOIN users maker ON maker.id = wm.user_id
     LEFT JOIN wallets wt ON wt.address = o.taker_address LEFT JOIN users taker ON taker.id = wt.user_id
     LEFT JOIN music mo ON mo.token_id = o.offered_token_id LEFT JOIN playlist po ON po.id = mo.album_id
     LEFT JOIN music mr ON mr.token_id = o.requested_token_id LEFT JOIN playlist pr ON pr.id = mr.album_id
     WHERE o.maker_address IN (${MY_WALLETS}) OR o.taker_address IN (${MY_WALLETS})
     ORDER BY o.created_block DESC, o.trade_id DESC
     LIMIT 100`,
    [req.userId]
  );
  res.json({ trades: rows });
});

export default router;
