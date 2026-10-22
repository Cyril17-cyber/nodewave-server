import { Router } from "express";
import { z } from "zod";
import { selectTracks } from "../lib/tracks.js";
import { optionalAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const uniqueBy = (items, key) => [...new Map(items.map((item) => [item[key], item])).values()];

router.get(
  "/",
  optionalAuth,
  validate({
    query: z.object({
      q: z.string().trim().min(1, "Enter something to search for").max(100),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  async (req, res) => {
    // Escape LIKE wildcards so user input is matched literally
    const pattern = `%${req.query.q.replace(/[\\%_]/g, "\\$&")}%`;
    const tracks = await selectTracks({
      where: "(m.title ILIKE $2 OR m.featured_artistes ILIKE $2 OR p.title ILIKE $2 OR u.name ILIKE $2)",
      params: [pattern],
      userId: req.userId,
      orderBy: "m.id DESC",
      limit: req.query.limit,
    });

    res.json({
      tracks,
      albums: uniqueBy(tracks, "album_id").map((t) => ({
        id: t.album_id,
        title: t.album_title,
        type: t.playlist_type,
        cover: t.cover,
        artiste_name: t.artiste_name,
      })),
      artistes: uniqueBy(tracks, "artiste_id").map((t) => ({
        id: t.artiste_id,
        name: t.artiste_name,
        display_picture_url: t.artiste_picture,
      })),
    });
  }
);

export default router;
