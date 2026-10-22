import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { pinFile, pinJson, unpin } from "../lib/pinata.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

const router = Router();
router.use(requireAuth, uploadLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

const recordUpload = (cid, userId, kind) =>
  pool.query("INSERT INTO uploads (cid, user_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [cid, userId, kind]);

/** Upload one audio or image file (multipart field "file") to IPFS. */
router.post(
  "/",
  validate({ query: z.object({ kind: z.enum(["audio", "image"]) }) }),
  upload.single("file"),
  async (req, res) => {
    const { kind } = req.query;
    if (!req.file) throw badRequest('Attach the file in a multipart field named "file"');
    if (!req.file.mimetype.startsWith(`${kind}/`)) throw badRequest(`Expected an ${kind} file`, "WRONG_FILE_TYPE");

    const pinned = await pinFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
    });
    await recordUpload(pinned.cid, req.userId, kind);
    res.status(201).json(pinned);
  }
);

/** Pin ERC-1155 metadata JSON (what wallets and marketplaces read from a token's URI). */
router.post(
  "/metadata",
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).default(""),
      image: z.string().min(1).max(500),
      animation_url: z.string().min(1).max(500),
      attributes: z
        .array(z.object({ trait_type: z.string().max(100), value: z.union([z.string().max(500), z.number(), z.boolean()]) }))
        .max(50)
        .default([]),
    }),
  }),
  async (req, res) => {
    const pinned = await pinJson(req.body, `${req.body.name}.json`);
    await recordUpload(pinned.cid, req.userId, "metadata");
    res.status(201).json(pinned);
  }
);

/** Unpin something you uploaded that never made it into a release (e.g. after a failed mint). */
router.delete("/:cid", validate({ params: z.object({ cid: z.string().regex(/^[a-zA-Z0-9]{46,100}$/) }) }), async (req, res) => {
  const { cid } = req.params;
  const owned = await pool.query("SELECT 1 FROM uploads WHERE cid = $1 AND user_id = $2", [cid, req.userId]);
  if (!owned.rows[0]) throw notFound("Upload not found", "UPLOAD_NOT_FOUND");

  const inUse = await pool.query(
    `SELECT 1 FROM chain_tokens WHERE uri LIKE '%' || $1 || '%'
     UNION ALL SELECT 1 FROM playlist WHERE cover LIKE '%' || $1 || '%' LIMIT 1`,
    [cid]
  );
  if (inUse.rows[0]) throw conflict("This file is part of a release and can't be removed.", "UPLOAD_IN_USE");

  await pool.query("DELETE FROM uploads WHERE cid = $1 AND user_id = $2", [cid, req.userId]);
  // IPFS is content-addressed: if someone else uploaded the identical file, it must stay pinned
  const others = await pool.query("SELECT 1 FROM uploads WHERE cid = $1 LIMIT 1", [cid]);
  if (!others.rows[0]) await unpin(cid);
  res.status(204).end();
});

export default router;
