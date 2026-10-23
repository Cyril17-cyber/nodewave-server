import { formatEther } from "viem";
import { pool } from "../db/pool.js";

/**
 * Releases newest first, for the marketplace and artiste pages.
 * Returns { playlists, nextOffset } where nextOffset is null on the last page.
 */
export async function listReleases({ limit = 30, offset = 0, type = null, artisteId = null }) {
  // One extra row tells us whether another page exists
  const { rows } = await pool.query(
    `SELECT p.id, p.playlist_type, p.cover, p.title, p.genre, p.record_label, p.created_at,
            u.id AS artiste_id, u.name AS artiste_name, u.display_picture_url AS artiste_picture,
            stats.track_count, stats.min_price_wei, stats.release_year
     FROM playlist p
     JOIN users u ON u.id = p.artiste_id
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS track_count, min(m.price_wei) AS min_price_wei, min(m.release_year) AS release_year
       FROM music m WHERE m.album_id = p.id
     ) stats
     WHERE ($3::text IS NULL OR p.playlist_type = $3) AND ($4::int IS NULL OR p.artiste_id = $4)
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $1 OFFSET $2`,
    [limit + 1, offset, type, artisteId]
  );
  const playlists = rows.slice(0, limit).map(({ min_price_wei, ...p }) => ({
    ...p,
    min_price: min_price_wei == null ? null : formatEther(BigInt(min_price_wei)),
  }));
  return { playlists, nextOffset: rows.length > limit ? offset + limit : null };
}
