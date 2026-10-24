import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { pinFile, pinJson, unpin } from "./pinata.js";
import { removeObject, signedObjectUrl, uploadObject } from "./supabase.js";

export const sha256Hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const PRIVATE_DIR = path.join(config.STORAGE_DIR, "private");
export const PUBLIC_DIR = path.join(config.STORAGE_DIR, "public");

const EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "application/json": ".json",
};

/**
 * Owner-only files (full tracks), only ever served through signed, expiring links.
 * Kept in a private Supabase Storage bucket when it's configured, otherwise on the API's disk.
 * `send` answers a request whose link has already been verified.
 */
const diskPrivateStorage = {
  async put(id, buffer) {
    await fs.mkdir(PRIVATE_DIR, { recursive: true });
    await fs.writeFile(path.join(PRIVATE_DIR, id), buffer);
  },
  async remove(id) {
    await fs.rm(path.join(PRIVATE_DIR, id), { force: true });
  },
  // sendFile handles Range requests, so seeking works
  send: (res, id, { contentType, maxAge }) =>
    new Promise((resolve, reject) =>
      res.sendFile(
        path.join(PRIVATE_DIR, id),
        { headers: { "Content-Type": contentType, "Cache-Control": `private, max-age=${maxAge}` } },
        (error) => (error && !res.headersSent ? reject(error) : resolve())
      )
    ),
};

const supabasePrivateStorage = {
  put: (id, buffer, contentType) => uploadObject(id, buffer, contentType),
  remove: (id) => removeObject(id),
  // Redirect to a Supabase link that lasts as long as ours, so the bytes don't pass through the API
  async send(res, id, { maxAge }) {
    const url = await signedObjectUrl(id, Math.max(maxAge, 60));
    res.set("Cache-Control", `private, max-age=${maxAge}`).redirect(302, url);
  },
};

export const privateStorage = config.supabaseStorageEnabled ? supabasePrivateStorage : diskPrivateStorage;

/**
 * Public files (covers, previews, token metadata). Pinned to IPFS through Pinata when it's
 * configured; otherwise written to local disk and served by the API at /v1/media/public.
 * Returns { cid, uri, url }: `uri` goes on-chain/in metadata, `url` is for browsers.
 */
export const publicStorage = {
  async putFile({ buffer, filename, mimetype }) {
    if (config.pinataEnabled) return pinFile({ buffer, filename, mimetype });
    return writeLocal(buffer, EXTENSIONS[mimetype] ?? path.extname(filename));
  },
  async putJson(content, name) {
    if (config.pinataEnabled) return pinJson(content, name);
    return writeLocal(Buffer.from(JSON.stringify(content, null, 2)), ".json");
  },
  async remove(cid) {
    if (config.pinataEnabled) return unpin(cid);
    const files = await fs.readdir(PUBLIC_DIR).catch(() => []);
    await Promise.all(files.filter((f) => f.startsWith(cid)).map((f) => fs.rm(path.join(PUBLIC_DIR, f), { force: true })));
  },
};

async function writeLocal(buffer, extension) {
  const cid = sha256Hex(buffer);
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.writeFile(path.join(PUBLIC_DIR, `${cid}${extension}`), buffer);
  const url = `${config.API_PUBLIC_URL}/v1/media/public/${cid}${extension}`;
  return { cid, uri: url, url };
}

const MEDIA_KEY = crypto.createHmac("sha256", config.JWT_SECRET).update("nodewave-media-links").digest();
const signature = (id, expires) => crypto.createHmac("sha256", MEDIA_KEY).update(`${id}.${expires}`).digest("base64url");

/** A link to a private file that works for MEDIA_URL_TTL_SECONDS (long enough to finish and seek a track). */
export function signedAudioUrl(id) {
  const expires = Math.floor(Date.now() / 1000) + config.MEDIA_URL_TTL_SECONDS;
  return {
    url: `${config.API_PUBLIC_URL}/v1/media/audio/${id}?exp=${expires}&sig=${signature(id, expires)}`,
    expiresAt: expires * 1000,
  };
}

export function verifyAudioSignature(id, expires, sig) {
  if (!/^\d+$/.test(String(expires)) || Number(expires) < Date.now() / 1000) return false;
  const expected = Buffer.from(signature(id, expires));
  const actual = Buffer.from(String(sig ?? ""));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
