import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { unauthorized } from "./errors.js";

const JWT_OPTIONS = { algorithm: "HS256", issuer: "nodewave-api", audience: "nodewave-clients" };

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** `sid` names the login (refresh token family) the access token was issued to. */
export function signAccessToken(userId, familyId) {
  return jwt.sign(familyId ? { sid: familyId } : {}, config.JWT_SECRET, {
    ...JWT_OPTIONS,
    subject: String(userId),
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns { userId, sessionId } from a valid access token, or throws 401. */
export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: [JWT_OPTIONS.algorithm],
      issuer: JWT_OPTIONS.issuer,
      audience: JWT_OPTIONS.audience,
    });
    return { userId: Number(payload.sub), sessionId: payload.sid };
  } catch {
    throw unauthorized("Invalid or expired access token", "INVALID_TOKEN");
  }
}

async function createRefreshToken(db, userId, familyId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, sha256(token), familyId, config.REFRESH_TOKEN_TTL_DAYS]
  );
  return token;
}

/**
 * The session payload every login/refresh endpoint returns. A login starts a new token
 * family; a refresh passes the family of the token it rotates.
 */
export async function issueSession(userId, db = pool, familyId = crypto.randomUUID()) {
  return {
    accessToken: signAccessToken(userId, familyId),
    accessTokenExpiresAt: Date.now() + config.ACCESS_TOKEN_TTL_SECONDS * 1000,
    refreshToken: await createRefreshToken(db, userId, familyId),
  };
}

/**
 * Exchanges a refresh token for a new session (rotation). A token that was already rotated
 * is accepted again only within a short grace window (concurrent refreshes from two tabs);
 * after that, presenting it means it was stolen or replayed, so that login's whole token
 * family is revoked. The user's other devices stay signed in.
 */
export async function rotateRefreshToken(token) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT *, now() - rotated_at <= make_interval(secs => $2) AS in_grace FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
      [sha256(token), config.REFRESH_REUSE_GRACE_SECONDS]
    );
    const row = rows[0];
    if (!row || row.revoked_at) return { error: "INVALID" };
    if (row.expires_at < new Date()) return { error: "EXPIRED" };
    if (row.rotated_at) {
      if (row.in_grace) return { userId: row.user_id, session: await issueSession(row.user_id, client, row.family_id) };
      await client.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL",
        [row.family_id]
      );
      return { error: "REUSED" };
    }

    await client.query("UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1", [row.id]);
    return { userId: row.user_id, session: await issueSession(row.user_id, client, row.family_id) };
  });
  // Thrown outside the transaction so the reuse revocation is committed
  if (result.error) throw unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  return result;
}

export async function revokeRefreshToken(token) {
  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
    sha256(token),
  ]);
}

/** Signs the user out everywhere, or everywhere but one login (`exceptFamilyId`). */
export async function revokeAllSessions(userId, db = pool, exceptFamilyId = null) {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND family_id IS DISTINCT FROM $2`,
    [userId, exceptFamilyId]
  );
}
