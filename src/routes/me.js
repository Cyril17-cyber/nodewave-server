import { Router } from "express";
import { formatEther } from "viem";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { selectTracks } from "../lib/tracks.js";
import { accountView } from "../lib/users.js";
import { requireAuth } from "../middleware/auth.js";
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
