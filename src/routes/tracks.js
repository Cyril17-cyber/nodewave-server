import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { forbidden, notFound } from "../lib/errors.js";
import { selectTracks } from "../lib/tracks.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const text = (max) => z.string().trim().max(max);
// Older rows hold nulls, which clients send straight back
const optionalText = (max) => text(max).nullish().transform((value) => value ?? "");

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
    const { rows } = await pool.query("SELECT artiste_id FROM music WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Track not found", "TRACK_NOT_FOUND");
    if (rows[0].artiste_id !== req.userId) throw forbidden("Only the artiste can edit this track.");

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
