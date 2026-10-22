import { config } from "../config.js";
import { AppError, unavailable } from "./errors.js";

const API = "https://api.pinata.cloud";

function assertConfigured() {
  if (!config.PINATA_JWT || !config.PINATA_GATEWAY) throw unavailable("File uploads are not configured");
}

async function pinataRequest(pathname, init) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.PINATA_JWT}`, ...init.headers },
  });
  if (!response.ok) {
    console.error(`Pinata ${pathname} failed: ${response.status} ${await response.text()}`);
    throw new AppError(502, "UPLOAD_FAILED", "The file storage service failed. Please try again.");
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

const describe = (cid) => ({ cid, uri: `ipfs://${cid}`, url: `https://${config.PINATA_GATEWAY}/ipfs/${cid}` });

export async function pinFile({ buffer, filename, mimetype }) {
  assertConfigured();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  const { IpfsHash } = await pinataRequest("/pinning/pinFileToIPFS", { method: "POST", body: form });
  return describe(IpfsHash);
}

export async function pinJson(content, name) {
  assertConfigured();
  const { IpfsHash } = await pinataRequest("/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
  });
  return describe(IpfsHash);
}

export async function unpin(cid) {
  assertConfigured();
  await pinataRequest(`/pinning/unpin/${encodeURIComponent(cid)}`, { method: "DELETE" });
}
