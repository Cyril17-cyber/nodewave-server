import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { pinFile, pinJson, unpin } from "./pinata.js";

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
 * Owner-only files (full tracks). Kept on the API's disk and only ever served through
 * signed, expiring links. Swap this object for an S3/R2 implementation to move storage.
 */
export const privateStorage = {
  async put(id, buffer) {
    await fs.mkdir(PRIVATE_DIR, { recursive: true });
    await fs.writeFile(path.join(PRIVATE_DIR, id), buffer);
  },
  path: (id) => path.join(PRIVATE_DIR, id),
  async remove(id) {
    await fs.rm(path.join(PRIVATE_DIR, id), { force: true });
  },
};

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
