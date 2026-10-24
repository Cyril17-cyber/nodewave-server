import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { startIndexer } from "./indexer/indexer.js";

await pool.query("SELECT 1"); // fail fast if the database is unreachable

const server = createApp().listen(config.PORT, () => {
  console.log(`Nodewave API listening on port ${config.PORT}`);
});

const stopIndexer = config.chainEnabled ? startIndexer() : null;
if (!stopIndexer) console.warn("RPC_URL / CONTRACT_ADDRESS not set: indexer and mint registration are disabled");
if (config.isProd && !config.supabaseStorageEnabled) console.warn(`Full tracks are stored on local disk (${config.STORAGE_DIR}); it must be persistent`);
if (config.isProd && !config.pinataEnabled) console.warn(`Public files are stored on local disk (${config.STORAGE_DIR}); it must be persistent`);
if (config.DATABASE_SSL && !config.DATABASE_SSL_CA) console.warn("DATABASE_SSL_CA not set: the database's certificate isn't verified");

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopIndexer?.();
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
