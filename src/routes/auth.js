import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { config } from "../config.js";
import { withTransaction, pool } from "../db/pool.js";
import { badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/mailer.js";
import { verifyGoogleIdToken, verifySpotifyAccessToken } from "../lib/oauth.js";
import { consumeOtp, issueOtp } from "../lib/otp.js";
import { issueSession, revokeAllSessions, revokeRefreshToken, rotateRefreshToken } from "../lib/tokens.js";
import { accountView, findUserByEmail, passwordSchema } from "../lib/users.js";
import { authLimiter, emailLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const email = z.email("Enter a valid email address").trim().toLowerCase();
const password = passwordSchema;
const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");

// Compared against when the email is unknown, so response time doesn't reveal which emails exist
const dummyHash = bcrypt.hashSync("nodewave-timing-equaliser", config.SALTROUNDS);

const sessionResponse = async (userId) => ({ user: await accountView(userId), ...(await issueSession(userId)) });

async function sendCode(user, purpose) {
  const otp = await issueOtp(user.id, purpose);
  if (!otp) return; // one was sent in the last minute
  const send = purpose === "verify_email" ? sendVerificationEmail : sendPasswordResetEmail;
  try {
    await send(user, otp);
  } catch (err) {
    // The account action still succeeded; the user can ask for the code again
    console.error(`Failed to send ${purpose} email to user ${user.id}:`, err.message);
  }
}

router.post(
  "/register",
  authLimiter,
  validate({ body: z.object({ name: z.string().trim().min(1).max(100), email, password }) }),
  async (req, res) => {
    const { name, email, password } = req.body;
    if (await findUserByEmail(email)) throw conflict("An account with this email already exists.", "EMAIL_IN_USE");

    const hash = await bcrypt.hash(password, config.SALTROUNDS);
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password, provider) VALUES ($1, $2, $3, 'credentials') RETURNING *",
      [name, email, hash]
    );
    await sendCode(rows[0], "verify_email");
    res.status(201).json({ message: "Check your email for a verification code.", user: await accountView(rows[0].id) });
  }
);

router.post("/verify-email", authLimiter, validate({ body: z.object({ email, code }) }), async (req, res) => {
  const user = await findUserByEmail(req.body.email);
  if (!user || !(await consumeOtp(user.id, "verify_email", req.body.code))) {
    throw badRequest("That code is invalid or has expired.", "INVALID_CODE");
  }
  await pool.query("UPDATE users SET verified = true WHERE id = $1", [user.id]);
  res.json(await sessionResponse(user.id));
});

router.post("/verify-email/resend", emailLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  const user = await findUserByEmail(req.body.email);
  if (user && !user.verified) await sendCode(user, "verify_email");
  // Same answer whether or not the account exists
  res.json({ message: "If that account needs verifying, a new code is on its way." });
});

router.post(
  "/login",
  authLimiter,
  validate({ body: z.object({ email, password: z.string().min(1) }) }),
  async (req, res) => {
    const user = await findUserByEmail(req.body.email);
    const valid = await bcrypt.compare(req.body.password, user?.password ?? dummyHash);
    if (!user?.password || !valid) throw unauthorized("Incorrect email or password.", "INVALID_CREDENTIALS");
    if (!user.verified) throw forbidden("Please verify your email before signing in.", "EMAIL_NOT_VERIFIED");
    res.json(await sessionResponse(user.id));
  }
);

router.post("/password/forgot", emailLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  const user = await findUserByEmail(req.body.email);
  if (user) await sendCode(user, "reset_password");
  res.json({ message: "If an account exists for that email, a reset code is on its way." });
});

router.post(
  "/password/reset",
  authLimiter,
  validate({ body: z.object({ email, code, password }) }),
  async (req, res) => {
    const user = await findUserByEmail(req.body.email);
    if (!user || !(await consumeOtp(user.id, "reset_password", req.body.code))) {
      throw badRequest("That code is invalid or has expired.", "INVALID_CODE");
    }
    const hash = await bcrypt.hash(req.body.password, config.SALTROUNDS);
    await withTransaction(async (client) => {
      // Receiving the code proves the email address, so this also verifies the account
      await client.query("UPDATE users SET password = $1, verified = true WHERE id = $2", [hash, user.id]);
      await revokeAllSessions(user.id, client);
    });
    res.json({ message: "Your password has been changed. Please sign in." });
  }
);

/**
 * Finds the account for a verified OAuth identity, linking or creating one as needed.
 * An existing account is only linked by email when the provider vouches for that email.
 */
async function findOrCreateOAuthUser(identity) {
  return withTransaction(async (client) => {
    const linked = await client.query(
      "SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2",
      [identity.provider, identity.providerAccountId]
    );
    if (linked.rows[0]) return linked.rows[0].user_id;

    const existing = await findUserByEmail(identity.email, client);
    let userId;
    if (existing) {
      // Accounts created by this provider before oauth_accounts existed have no link row yet;
      // they were created from this provider's email, so linking them is no new trust.
      const { rows: links } = await client.query("SELECT 1 FROM oauth_accounts WHERE user_id = $1 LIMIT 1", [existing.id]);
      const legacyAccount = existing.provider === identity.provider && !links[0];
      if (!identity.emailVerified && !legacyAccount) {
        throw conflict(
          "An account with this email already exists. Sign in the way you originally signed up.",
          "EMAIL_IN_USE"
        );
      }
      userId = existing.id;
      // If someone pre-registered this email with a password and never verified it,
      // wipe that password so they can't sign into the real owner's account.
      await client.query(
        `UPDATE users SET verified = true,
                password = CASE WHEN verified THEN password ELSE NULL END,
                display_picture_url = coalesce(display_picture_url, $2)
         WHERE id = $1`,
        [userId, identity.image]
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO users (name, email, display_picture_url, verified, provider)
         VALUES ($1, $2, $3, true, $4) RETURNING id`,
        [identity.name, identity.email.toLowerCase(), identity.image, identity.provider]
      );
      userId = rows[0].id;
    }
    await client.query("INSERT INTO oauth_accounts (provider, provider_account_id, user_id) VALUES ($1, $2, $3)", [
      identity.provider,
      identity.providerAccountId,
      userId,
    ]);
    return userId;
  });
}

router.post(
  "/oauth/google",
  authLimiter,
  validate({ body: z.object({ idToken: z.string().min(1) }) }),
  async (req, res) => {
    const userId = await findOrCreateOAuthUser(await verifyGoogleIdToken(req.body.idToken));
    res.json(await sessionResponse(userId));
  }
);

router.post(
  "/oauth/spotify",
  authLimiter,
  validate({ body: z.object({ accessToken: z.string().min(1) }) }),
  async (req, res) => {
    const userId = await findOrCreateOAuthUser(await verifySpotifyAccessToken(req.body.accessToken));
    res.json(await sessionResponse(userId));
  }
);

router.post("/refresh", validate({ body: z.object({ refreshToken: z.string().min(1) }) }), async (req, res) => {
  const { session } = await rotateRefreshToken(req.body.refreshToken);
  res.json(session);
});

router.post("/logout", validate({ body: z.object({ refreshToken: z.string().min(1) }) }), async (req, res) => {
  await revokeRefreshToken(req.body.refreshToken);
  res.status(204).end();
});

export default router;
