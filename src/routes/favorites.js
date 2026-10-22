import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { accountView } from "../lib/users.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);

const trackId = z.coerce.number().int().positive();

// Both endpoints return the updated account so clients can refresh their copy of `favorites`
router.post("/", validate({ body: z.object({ trackId }) }), async (req, res) => {
  const { rows } = await pool.query("SELECT 1 FROM music WHERE id = $1", [req.body.trackId]);
  if (!rows[0]) throw notFound("Track not found", "TRACK_NOT_FOUND");
  await pool.query("INSERT INTO favorites (user_id, music_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    req.userId,
    req.body.trackId,
  ]);
  res.json({ user: await accountView(req.userId) });
});

router.delete("/:trackId", validate({ params: z.object({ trackId }) }), async (req, res) => {
  await pool.query("DELETE FROM favorites WHERE user_id = $1 AND music_id = $2", [req.userId, req.params.trackId]);
  res.json({ user: await accountView(req.userId) });
});

export default router;
