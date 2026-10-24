import { config } from "../config.js";
import { AppError } from "./errors.js";

// Supabase Storage's REST API, called with the project's secret (service role) key.
// The bucket must be private: objects are only reachable through signed URLs.
async function storageRequest(pathname, { headers, ...init }) {
  const response = await fetch(`${config.SUPABASE_URL}/storage/v1${pathname}`, {
    ...init,
    headers: { apikey: config.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, ...headers },
  });
  if (!response.ok) {
    console.error(`Supabase Storage ${pathname} failed: ${response.status} ${await response.text()}`);
    throw new AppError(502, "STORAGE_FAILED", "The file storage service failed. Please try again.");
  }
  return response.json().catch(() => null);
}

const bucket = () => encodeURIComponent(config.SUPABASE_BUCKET);
const jsonHeaders = { "Content-Type": "application/json" };

export function uploadObject(name, buffer, contentType) {
  return storageRequest(`/object/${bucket()}/${name}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-upsert": "true" }, // the uploader may retry the same audio
    body: buffer,
  });
}

export function removeObject(name) {
  return storageRequest(`/object/${bucket()}`, {
    method: "DELETE",
    headers: jsonHeaders,
    body: JSON.stringify({ prefixes: [name] }),
  });
}

/** A URL that serves the object (with Range support) for `seconds`. */
export async function signedObjectUrl(name, seconds) {
  const { signedURL } = await storageRequest(`/object/sign/${bucket()}/${name}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ expiresIn: seconds }),
  });
  return `${config.SUPABASE_URL}/storage/v1${signedURL}`;
}
