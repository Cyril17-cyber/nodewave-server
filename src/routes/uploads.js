import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { makePreview } from "../lib/audio.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { privateStorage, publicStorage, sha256Hex } from "../lib/storage.js";
import { findUserById } from "../lib/users.js";
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

/** Upload a cover image (multipart field "file"). Public. */
router.post("/", validate({ query: z.object({ kind: z.enum(["image"]) }) }), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest('Attach the file in a multipart field named "file"');
  if (!req.file.mimetype.startsWith("image/")) throw badRequest("Expected an image file", "WRONG_FILE_TYPE");

  const stored = await publicStorage.putFile({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
  });
  await recordUpload(stored.cid, req.userId, "image");
  res.status(201).json(stored);
});

/**
 * Upload one track before minting (multipart: "file" plus the fields below).
 * - the full audio is stored privately and only ever streamed to owners
 * - a public 30-second preview is cut from it
 * - ERC-1155 metadata (name, cover, preview) is published; its URI is what you mint with
 */
router.post(
  "/track",
  upload.single("file"),
  validate({
    body: z.object({
      title: z.string().trim().min(1).max(200),
      coverUri: z.string().trim().min(1).max(500),
      genre: z.string().trim().max(100).default(""),
      explicit: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    }),
  }),
  async (req, res) => {
    if (!req.file) throw badRequest('Attach the audio in a multipart field named "file"');
    if (!req.file.mimetype.startsWith("audio/")) throw badRequest("Expected an audio file", "WRONG_FILE_TYPE");

    const id = sha256Hex(req.file.buffer);
    const { rows: existing } = await pool.query(
      `SELECT a.user_id, m.id AS music_id FROM audio_files a LEFT JOIN music m ON m.audio_id = a.id WHERE a.id = $1`,
      [id]
    );
    if (existing[0] && (existing[0].user_id !== req.userId || existing[0].music_id)) {
      throw conflict("This audio has already been uploaded or minted.", "AUDIO_EXISTS");
    }

    const preview = await makePreview(req.file.buffer);
    const artiste = await findUserById(req.userId);
    const { title, coverUri, genre, explicit } = req.body;

    const previewFile = await publicStorage.putFile({ buffer: preview, filename: "preview.mp3", mimetype: "audio/mpeg" });
    const metadata = await publicStorage.putJson(
      {
        name: title,
        description: `${title} by ${artiste.name}. Collect it on Nodewave to hear the full track.`,
        image: coverUri,
        animation_url: previewFile.uri,
        external_url: config.CLIENTURL,
        attributes: [
          { trait_type: "Artiste", value: artiste.name },
          ...(genre ? [{ trait_type: "Genre", value: genre }] : []),
          { trait_type: "Explicit", value: explicit },
        ],
        properties: {
          preview_seconds: config.PREVIEW_SECONDS,
          // Ties the metadata to this exact audio and keeps every token URI unique
          audio_sha256: id,
        },
      },
      `${title}.json`
    );

    await privateStorage.put(id, req.file.buffer);
    await pool.query(
      `INSERT INTO audio_files (id, user_id, mime_type, size_bytes, preview_url, metadata_uri)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET preview_url = EXCLUDED.preview_url, metadata_uri = EXCLUDED.metadata_uri`,
      [id, req.userId, req.file.mimetype, req.file.size, previewFile.url, metadata.uri]
    );
    await recordUpload(previewFile.cid, req.userId, "audio");
    await recordUpload(metadata.cid, req.userId, "metadata");

    res.status(201).json({ audioId: id, uri: metadata.uri, previewUrl: previewFile.url });
  }
);

/** Remove an uploaded track that never got minted (e.g. after a failed mint). */
router.delete(
  "/track/:audioId",
  validate({ params: z.object({ audioId: z.string().regex(/^[0-9a-f]{64}$/) }) }),
  async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM audio_files a WHERE a.id = $1 AND a.user_id = $2
         AND NOT EXISTS (SELECT 1 FROM music m WHERE m.audio_id = a.id)
       RETURNING id`,
      [req.params.audioId, req.userId]
    );
    if (!rows[0]) throw notFound("Upload not found or already minted", "UPLOAD_NOT_FOUND");
    await privateStorage.remove(req.params.audioId);
    res.status(204).end();
  }
);

/** Unpin a public file you uploaded that never made it into a release. */
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
  // Content-addressed: if someone else uploaded the identical file, it must stay
  const others = await pool.query("SELECT 1 FROM uploads WHERE cid = $1 LIMIT 1", [cid]);
  if (!others.rows[0]) await publicStorage.remove(cid);
  res.status(204).end();
});

export default router;
