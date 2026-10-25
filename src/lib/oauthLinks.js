import crypto from "node:crypto";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { OTP_TTL_MINUTES } from "./otp.js";

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const hmac = (value) => crypto.createHmac("sha256", config.JWT_SECRET).update(value).digest("hex");
const tokenHash = (token) => hmac(`oauth-link-token:${token}`);
const codeHash = (token, code) => hmac(`oauth-link-code:${token}:${code}`);

/**
 * Starts linking a provider identity to an existing account, replacing any earlier attempt.
 * Returns { token, code }: the token goes back to the browser, the code to the account's email.
 * Returns null if a link for this account was started in the last minute.
 */
export async function startOAuthLink(userId, identity) {
  const token = crypto.randomBytes(32).toString("base64url");
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const { rowCount } = await pool.query(
    `INSERT INTO pending_oauth_links (user_id, token_hash, provider, provider_account_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, provider = EXCLUDED.provider,
           provider_account_id = EXCLUDED.provider_account_id, code_hash = EXCLUDED.code_hash,
           attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE pending_oauth_links.created_at < now() - make_interval(secs => $7)`,
    [userId, tokenHash(token), identity.provider, identity.providerAccountId, codeHash(token, code), OTP_TTL_MINUTES, RESEND_COOLDOWN_SECONDS]
  );
  return rowCount ? { token, code } : null;
}

export async function cancelOAuthLink(token) {
  await pool.query("DELETE FROM pending_oauth_links WHERE token_hash = $1", [tokenHash(token)]);
}

/**
 * Checks the emailed code for a pending link and consumes the link on success, returning
 * { userId, provider, providerAccountId }. Wrong guesses count against the link, which is
 * destroyed after MAX_ATTEMPTS.
 */
export async function consumeOAuthLink(token, code) {
  return withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM pending_oauth_links WHERE token_hash = $1 FOR UPDATE", [
      tokenHash(token),
    ]);
    const row = rows[0];
    if (!row) return null;

    if (row.expires_at < new Date() || row.attempts >= MAX_ATTEMPTS) {
      await client.query("DELETE FROM pending_oauth_links WHERE user_id = $1", [row.user_id]);
      return null;
    }

    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(codeHash(token, code), "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      await client.query("UPDATE pending_oauth_links SET attempts = attempts + 1 WHERE user_id = $1", [row.user_id]);
      return null;
    }

    await client.query("DELETE FROM pending_oauth_links WHERE user_id = $1", [row.user_id]);
    return { userId: row.user_id, provider: row.provider, providerAccountId: row.provider_account_id };
  });
}
