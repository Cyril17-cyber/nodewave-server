import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { listReleases } from "../lib/releases.js";
import { publicProfile } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

const router = Router();

/** An artiste's public profile with their releases (first page) and catalogue stats. */
router.get("/:id", validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.*,
            (SELECT count(*)::int FROM playlist p WHERE p.artiste_id = u.id) AS release_count,
            (SELECT count(*)::int FROM music m WHERE m.artiste_id = u.id) AS track_count
     FROM users u WHERE u.id = $1`,
    [req.params.id]
  );
  const user = rows[0];
  if (!user || user.release_count === 0) throw notFound("Artiste not found", "ARTISTE_NOT_FOUND");

  const releases = await listReleases({ artisteId: user.id, limit: 50 });
  res.json({
    artiste: { ...publicProfile(user), release_count: user.release_count, track_count: user.track_count },
    ...releases,
  });
});

export default router;
