import express, { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { forbidden, notFound } from "../lib/errors.js";
import { PUBLIC_DIR, privateStorage, verifyAudioSignature } from "../lib/storage.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// <audio> and <img> load these from the web app's origin, so allow cross-origin embedding
router.use((_req, res, next) => {
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

/**
 * Streams a full track. Only reachable through a link from GET /v1/tracks/:id/stream,
 * which checks ownership; the signature and expiry make the link useless once shared.
 * Supports Range requests, so seeking works.
 */
router.get(
  "/audio/:id",
  validate({
    params: z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }),
    query: z.object({ exp: z.string(), sig: z.string() }),
  }),
  async (req, res, next) => {
    if (!verifyAudioSignature(req.params.id, req.query.exp, req.query.sig)) {
      throw forbidden("This link has expired.", "LINK_EXPIRED");
    }
    const { rows } = await pool.query("SELECT mime_type FROM audio_files WHERE id = $1", [req.params.id]);
    if (!rows[0]) throw notFound("Audio not found", "AUDIO_NOT_FOUND");

    const maxAge = Math.max(0, Number(req.query.exp) - Math.floor(Date.now() / 1000));
    res.sendFile(
      privateStorage.path(req.params.id),
      { headers: { "Content-Type": rows[0].mime_type, "Cache-Control": `private, max-age=${maxAge}` } },
      (error) => error && !res.headersSent && next(error)
    );
  }
);

// Covers, previews and metadata when Pinata isn't configured. Names are content hashes.
router.use(
  "/public",
  express.static(PUBLIC_DIR, { immutable: true, maxAge: "365d", index: false, fallthrough: false })
);

export default router;
