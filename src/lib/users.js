import { pool } from "../db/pool.js";

/** Fields of another user that anyone may see. */
export function publicProfile(user) {
  return {
    id: user.id,
    name: user.name,
    display_picture_url: user.display_picture_url,
  };
}

export const findUserByEmail = async (email, db = pool) =>
  (await db.query("SELECT * FROM users WHERE lower(email) = lower($1)", [email])).rows[0];

export const findUserById = async (id, db = pool) =>
  (await db.query("SELECT * FROM users WHERE id = $1", [id])).rows[0];

/**
 * The signed-in user's own view of their account. Never includes the password hash.
 * The arrays keep the shape the frontend already uses (string ids).
 */
export async function accountView(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.uuid, u.name, u.email, u.display_picture_url, u.verified, u.provider,
            coalesce((SELECT array_agg(f.music_id::text ORDER BY f.created_at)
                      FROM favorites f WHERE f.user_id = u.id), '{}') AS favorites,
            coalesce((SELECT array_agg(m.id::text ORDER BY m.id)
                      FROM music m WHERE m.artiste_id = u.id), '{}') AS minted_tracks,
            coalesce((SELECT array_agg(DISTINCT m.id::text)
                      FROM purchases p
                      JOIN wallets w ON w.address = p.buyer_address
                      JOIN music m ON m.token_id = p.token_id
                      WHERE w.user_id = u.id), '{}') AS purchased_songs,
            coalesce((SELECT array_agg(w.address ORDER BY w.linked_at)
                      FROM wallets w WHERE w.user_id = u.id), '{}') AS wallets
     FROM users u WHERE u.id = $1`,
    [userId]
  );
  return rows[0];
}

