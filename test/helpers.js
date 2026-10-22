// Must be imported before anything from src/, so config sees the test environment.
process.env.NODE_ENV = "test";
process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME || "nodewave_test";
process.env.GOOGLE_CLIENT_IDS ||= "test-client-id.apps.googleusercontent.com";
process.env.PINATA_JWT ||= "test-pinata-jwt";
process.env.PINATA_GATEWAY ||= "test.mypinata.cloud";
process.env.CLIENTURL = "http://localhost:3000";
process.env.REFRESH_REUSE_GRACE_SECONDS ??= "0";

import request from "supertest";

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
