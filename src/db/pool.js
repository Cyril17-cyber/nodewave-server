import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  host: config.DATABASE_HOST,
  port: config.DATABASE_PORT,
  user: config.DATABASE_USER,
  password: config.DATABASE_PASSWORD,
  database: config.DATABASE_NAME,
  // Without the CA the connection is still encrypted, but the server's certificate isn't checked
  ssl: config.DATABASE_SSL && (config.DATABASE_SSL_CA ? { ca: config.DATABASE_SSL_CA } : { rejectUnauthorized: false }),
  max: 10,
});

// A dropped idle connection must not crash the process; the pool replaces it.
pool.on("error", (err) => console.error("Postgres idle client error:", err.message));

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
