import { formatEther } from "viem";
import { pool } from "../db/pool.js";

/**
 * Selects tracks in the one shape every endpoint returns: catalogue fields, release and
 * artiste details, on-chain state (uri, supply), and — for the signed-in user — how many
 * copies they own across their linked wallets and whether it's a favourite.
 *
 * `where` and `params` use placeholders from $2; $1 is always the user id (or null).
 */
export async function selectTracks({ where = "true", params = [], userId = null, orderBy = "m.id", limit = 500 }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.featured_artistes, m.writers, m.producers, m.explicit, m.song_duration,
            m.price, m.price_wei, m.token_id, m.artiste_id, m.album_id, m.release_day, m.release_year, m.released_at,
            p.title AS album_title, p.cover, p.playlist_type,
            u.name AS artiste_name, u.display_picture_url AS artiste_picture,
            ct.uri, ct.supply, ct.artiste_address,
            af.preview_url, (m.audio_id IS NOT NULL) AS gated,
            resale.min_price_wei AS min_resale_price_wei, coalesce(resale.listings, 0) AS resale_listings,
            coalesce(owned.amount, 0) AS owned,
            (f.user_id IS NOT NULL) AS favorite
     FROM music m
     JOIN playlist p ON p.id = m.album_id
     JOIN users u ON u.id = m.artiste_id
     LEFT JOIN chain_tokens ct ON ct.token_id = m.token_id
     LEFT JOIN audio_files af ON af.id = m.audio_id
     LEFT JOIN LATERAL (
       SELECT min(l.price_wei) AS min_price_wei, count(*)::int AS listings
       FROM chain_resale_listings l WHERE l.token_id = m.token_id AND l.active AND l.amount > 0
     ) resale ON true
     LEFT JOIN LATERAL (
       SELECT sum(b.amount) AS amount
       FROM token_balances b JOIN wallets w ON w.address = b.address
       WHERE w.user_id = $1 AND b.token_id = m.token_id
     ) owned ON true
     LEFT JOIN favorites f ON f.music_id = m.id AND f.user_id = $1
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ${Number(limit)}`,
    [userId, ...params]
  );
  return rows.map(trackView);
}

/** A track row as clients see it. Price comes from the on-chain wei amount when known. */
export function trackView({ min_resale_price_wei, ...track }) {
  return {
    ...track,
    min_resale_price: min_resale_price_wei == null ? null : formatEther(BigInt(min_resale_price_wei)),
    price: track.price_wei != null ? formatEther(BigInt(track.price_wei)) : track.price,
    owned: Number(track.owned ?? 0),
    // null until the indexer has seen the mint
    sold: track.supply == null ? null : track.supply === "0",
  };
}

/** Copies of a track the user holds across their linked wallets. */
export async function ownedCopies(userId, tokenId) {
  const { rows } = await pool.query(
    `SELECT coalesce(sum(b.amount), 0) AS amount
     FROM token_balances b JOIN wallets w ON w.address = b.address
     WHERE w.user_id = $1 AND b.token_id = $2`,
    [userId, tokenId]
  );
  return Number(rows[0].amount);
}
