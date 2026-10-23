import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import request from "supertest";

// Must be imported before anything from src/, so config sees the test environment.
process.env.NODE_ENV = "test";
process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME || "nodewave_test";
process.env.GOOGLE_CLIENT_IDS ??= "test-client-id.apps.googleusercontent.com";
// Set PINATA_JWT="" before importing this file to test local public storage instead
process.env.PINATA_JWT ??= "test-pinata-jwt";
process.env.PINATA_GATEWAY ??= "test.mypinata.cloud";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nodewave-test-"));
process.env.API_PUBLIC_URL = "http://api.test";
process.env.CLIENTURL = "http://localhost:3000";
process.env.REFRESH_REUSE_GRACE_SECONDS ??= "0";

/** A short MP3 sine tone; different frequencies give different files (and hashes). */
export function makeTone({ seconds = 40, frequency = 440 } = {}) {
  return execFileSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1",
  ]);
}

/** Path + query of an absolute API URL, for supertest. */
export const apiPath = (url) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** Recreates the test schema from the migrations and returns the app plus helpers. */
export async function setup() {
  const { pool } = await import("../src/db/pool.js");
  const { migrate } = await import("../src/db/migrate.js");
  const { createApp } = await import("../src/app.js");
  const { testOutbox } = await import("../src/lib/mailer.js");

  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate({ log: () => {} });

  const app = createApp();
  const api = () => request(app);

  const lastCode = (email, purpose) =>
    [...testOutbox].reverse().find((mail) => mail.to === email && mail.purpose === purpose)?.code;

  /** Registers and verifies a user; returns their session. */
  async function createUser(email = `user${Math.random().toString(36).slice(2)}@example.com`, password = "correct horse") {
    await api().post("/v1/auth/register").send({ name: "Test User", email, password }).expect(201);
    const { body } = await api()
      .post("/v1/auth/verify-email")
      .send({ email, code: lastCode(email, "verify_email") })
      .expect(200);
    return { ...body, email, password, auth: { Authorization: `Bearer ${body.accessToken}` } };
  }

  return { app, api, pool, testOutbox, lastCode, createUser };
}
