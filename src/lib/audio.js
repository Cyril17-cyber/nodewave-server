import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { config } from "../config.js";
import { badRequest } from "./errors.js";

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr: stderr.toString() })) : resolve(stdout)
    );
  });
}

/**
 * Cuts the first PREVIEW_SECONDS of a track into a 128 kbps MP3 with a short fade-out.
 * Also proves the upload really is decodable audio. Returns the MP3 bytes.
 */
export async function makePreview(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nodewave-"));
  const input = path.join(dir, "input");
  try {
    await fs.writeFile(input, buffer);
    const seconds = config.PREVIEW_SECONDS;
    const preview = await ffmpeg([
      "-hide_banner", "-loglevel", "error",
      "-t", String(seconds), "-i", input,
      "-vn", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k",
      "-af", `afade=t=out:st=${Math.max(seconds - 3, 0)}:d=3`,
      "-f", "mp3", "pipe:1",
    ]);
    if (!preview.length) throw new Error("empty preview");
    return preview;
  } catch (error) {
    console.error("Preview generation failed:", error.stderr || error.message);
    throw badRequest("That file isn't audio we can read.", "UNSUPPORTED_AUDIO");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
