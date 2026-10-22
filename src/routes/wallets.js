import { Router } from "express";
import { verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { z } from "zod";
import { publicClient } from "../chain/client.js";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { accountView } from "../lib/users.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth);

const NONCE_TTL_MINUTES = 10;

/** Step 1: get a single-use nonce to put in the Sign-In With Ethereum message. */
router.post("/nonce", async (req, res) => {
  const nonce = generateSiweNonce();
  await pool.query("DELETE FROM siwe_nonces WHERE expires_at < now()");
  await pool.query(
    "INSERT INTO siwe_nonces (nonce, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
    [nonce, req.userId, NONCE_TTL_MINUTES]
  );
  res.json({ nonce, domains: config.SIWE_DOMAINS });
});

/** Step 2: submit the signed message; the signing address is linked to this account. */
router.post(
  "/",
  validate({
    body: z.object({
      message: z.string().min(1).max(4000),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    }),
  }),
  async (req, res) => {
    const { message, signature } = req.body;
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce || !parsed.domain) throw badRequest("Malformed sign-in message", "INVALID_SIWE");
    if (!config.SIWE_DOMAINS.includes(parsed.domain)) throw badRequest("Sign-in message is for another site", "INVALID_SIWE");
    if (!validateSiweMessage({ message: parsed, time: new Date() })) {
      throw badRequest("Sign-in message has expired", "INVALID_SIWE");
    }

    // Nonces are single use and tied to the account that requested them
    const { rowCount } = await pool.query(
      "DELETE FROM siwe_nonces WHERE nonce = $1 AND user_id = $2 AND expires_at > now()",
      [parsed.nonce, req.userId]
    );
    if (!rowCount) throw badRequest("Sign-in message has expired. Please try again.", "INVALID_SIWE");

    // Through the RPC this also accepts smart-contract wallets (ERC-1271/6492)
    const valid = publicClient
      ? await publicClient.verifyMessage({ address: parsed.address, message, signature })
      : await verifyMessage({ address: parsed.address, message, signature });
    if (!valid) throw badRequest("Signature doesn't match the wallet address", "INVALID_SIWE");

    const address = parsed.address.toLowerCase();
    await withTransaction(async (client) => {
      const { rows } = await client.query("SELECT user_id FROM wallets WHERE address = $1 FOR UPDATE", [address]);
      if (rows[0] && rows[0].user_id !== req.userId) {
        throw conflict("This wallet is linked to another account.", "WALLET_IN_USE");
      }
      if (!rows[0]) await client.query("INSERT INTO wallets (address, user_id) VALUES ($1, $2)", [address, req.userId]);
    });
    res.status(201).json({ address, user: await accountView(req.userId) });
  }
);

router.delete(
  "/:address",
  validate({ params: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).toLowerCase() }) }),
  async (req, res) => {
    const { rowCount } = await pool.query("DELETE FROM wallets WHERE address = $1 AND user_id = $2", [
      req.params.address,
      req.userId,
    ]);
    if (!rowCount) throw notFound("Wallet not linked to this account", "WALLET_NOT_FOUND");
    res.json({ user: await accountView(req.userId) });
  }
);

export default router;
