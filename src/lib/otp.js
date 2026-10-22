import crypto from "node:crypto";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";

export const OTP_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const hashCode = (userId, purpose, code) =>
  crypto.createHmac("sha256", config.JWT_SECRET).update(`${purpose}:${userId}:${code}`).digest("hex");

/**
 * Creates a fresh 6-digit code for the user, replacing any previous one.
 * Returns null (and keeps the old code) if one was issued in the last minute.
 */
export async function issueOtp(userId, purpose) {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const { rowCount } = await pool.query(
    `INSERT INTO otp_codes (user_id, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))
     ON CONFLICT (user_id, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE otp_codes.created_at < now() - make_interval(secs => $5)`,
    [userId, purpose, hashCode(userId, purpose, code), OTP_TTL_MINUTES, RESEND_COOLDOWN_SECONDS]
  );
  return rowCount ? code : null;
}

/**
 * Checks a code and consumes it on success. Wrong guesses count against the code,
 * which is destroyed after MAX_ATTEMPTS.
 */
export async function consumeOtp(userId, purpose, code) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM otp_codes WHERE user_id = $1 AND purpose = $2 FOR UPDATE",
      [userId, purpose]
    );
    const row = rows[0];
    if (!row) return false;

    if (row.expires_at < new Date() || row.attempts >= MAX_ATTEMPTS) {
      await client.query("DELETE FROM otp_codes WHERE user_id = $1 AND purpose = $2", [userId, purpose]);
      return false;
    }

    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(hashCode(userId, purpose, code), "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      await client.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE user_id = $1 AND purpose = $2", [
        userId,
        purpose,
      ]);
      return false;
    }

    await client.query("DELETE FROM otp_codes WHERE user_id = $1 AND purpose = $2", [userId, purpose]);
    return true;
  });
}
