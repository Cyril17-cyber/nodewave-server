import { Router } from "express";
import { formatEther } from "viem";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { forbidden, notFound } from "../lib/errors.js";
import { signedAudioUrl } from "../lib/storage.js";
import { ownedCopies, selectTracks } from "../lib/tracks.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const text = (max) => z.string().trim().max(max);
// Older rows hold nulls, which clients send straight back
const optionalText = (max) => text(max).nullish().transform((value) => value ?? "");
const trackParams = validate({ params: z.object({ id: z.coerce.number().int().positive() }) });

async function findTrack(id) {
  const { rows } = await pool.query("SELECT id, artiste_id, token_id, audio_id FROM music WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("Track not found", "TRACK_NOT_FOUND");
  return rows[0];
}

/**
 * A short-lived link to the full track, for people who own a copy (or the artiste).
 * Everyone else plays the public preview from the track's `preview_url`.
 */
router.get("/:id/stream", requireAuth, trackParams, async (req, res) => {
  const track = await findTrack(req.params.id);
  const isArtiste = track.artiste_id === req.userId;
  if (!isArtiste && (await ownedCopies(req.userId, track.token_id)) < 1) {
    throw forbidden("Buy this track to hear the full version.", "NOT_OWNED");
  }

  if (track.audio_id) return res.json(signedAudioUrl(track.audio_id));

  // Minted before gating existed: the token URI is the audio itself (already public)
  const { rows } = await pool.query("SELECT uri FROM chain_tokens WHERE token_id = $1", [track.token_id]);
  if (!rows[0]) throw notFound("This track's audio isn't available yet.", "AUDIO_NOT_FOUND");
  res.json({ url: rows[0].uri, expiresAt: null });
});

/** Copies listed for resale by collectors, cheapest first. */
router.get("/:id/listings", optionalAuth, trackParams, async (req, res) => {
  const track = await findTrack(req.params.id);
  const { rows } = await pool.query(
    `SELECT l.listing_id, l.seller_address, l.amount, l.price_wei,
            u.id AS seller_id, u.name AS seller_name,
            (u.id IS NOT NULL AND u.id = $2) AS mine
     FROM chain_resale_listings l
     LEFT JOIN wallets w ON w.address = l.seller_address
     LEFT JOIN users u ON u.id = w.user_id
     WHERE l.token_id = $1 AND l.active AND l.amount > 0
     ORDER BY l.price_wei, l.listing_id`,
    [track.token_id, req.userId ?? null]
  );
  res.json({
    listings: rows.map(({ price_wei, ...listing }) => ({ ...listing, price_wei, price: formatEther(BigInt(price_wei)) })),
  });
});

/** Other collectors who hold this track (through a linked wallet), for proposing trades. */
router.get("/:id/holders", requireAuth, trackParams, async (req, res) => {
  const track = await findTrack(req.params.id);
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.name, u.display_picture_url, b.address, b.amount
     FROM token_balances b
     JOIN wallets w ON w.address = b.address
     JOIN users u ON u.id = w.user_id
     WHERE b.token_id = $1 AND b.amount > 0 AND u.id <> $2 AND b.address <> $3
     ORDER BY b.amount DESC, u.name
     LIMIT 50`,
    [track.token_id, req.userId, config.CONTRACT_ADDRESS ?? ""]
  );
  res.json({ holders: rows.map((h) => ({ ...h, amount: Number(h.amount) })) });
});

router.patch(
  "/:id",
  requireAuth,
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      title: text(200).min(1),
      featuredArtistes: optionalText(500),
      writers: text(500).min(1),
      producers: text(500).min(1),
      explicit: z.boolean().nullish().transform((value) => value ?? false),
    }),
  }),
  async (req, res) => {
    const existing = await findTrack(req.params.id);
    if (existing.artiste_id !== req.userId) throw forbidden("Only the artiste can edit this track.");

    const { title, featuredArtistes, writers, producers, explicit } = req.body;
    await pool.query(
      `UPDATE music SET title = $1, featured_artistes = $2, writers = $3, producers = $4, explicit = $5
       WHERE id = $6`,
      [title, featuredArtistes, writers, producers, explicit, req.params.id]
    );
    const [track] = await selectTracks({ where: "m.id = $2", params: [req.params.id], userId: req.userId });
    res.json({ track });
  }
);

export default router;
