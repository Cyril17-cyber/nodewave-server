// Clears everything that came from a blockchain, for after restarting the local Hardhat node
// (which starts a brand-new chain). Keeps users, linked wallets and sessions.
//   npm run reset-chain -- --yes
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";

if (config.isProd) {
  console.error("Refusing to run in production.");
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.error(
    `This deletes all releases, tracks, favourites, plays and indexed chain data in "${config.DATABASE_NAME}".\n` +
      "Users and linked wallets are kept. Run again with --yes to continue."
  );
  process.exit(1);
}

const tables = [
  // indexed from the old chain
  "chain_events",
  "chain_tokens",
  "chain_resale_listings",
  "chain_trade_offers",
  "purchases",
  "token_balances",
  "indexer_state",
  // releases point at token ids that don't exist on the new chain
  "plays",
  "favorites",
  "music",
  "playlist",
  "audio_files",
  "uploads",
];

await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
console.log(`Cleared ${tables.length} tables in "${config.DATABASE_NAME}". Uploaded files in STORAGE_DIR were left alone.`);
await pool.end();
