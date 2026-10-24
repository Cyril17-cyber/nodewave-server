import { formatEther } from "viem";
import { nodewaveAbi, publicClient } from "../chain/client.js";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";

const STATE_ID = "nodewave";
const lower = (address) => address.toLowerCase();

/**
 * Applies one decoded event to the mirror tables. Each handler runs at most once per
 * (txHash, logIndex) because the event is first recorded in chain_events.
 */
const handlers = {
  async MarketItemCreated(db, { tokenId, uri, artiste, price, supply }, log) {
    await db.query(
      `INSERT INTO chain_tokens (token_id, uri, artiste_address, price_wei, supply, minted_tx_hash, minted_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (token_id) DO NOTHING`,
      [tokenId.toString(), uri, lower(artiste), price.toString(), supply.toString(), log.transactionHash, log.blockNumber.toString()]
    );
    await recordMintFee(db, artiste, log);
  },

  async CollectionCreated(db, { collectionId, firstTokenId, trackCount }) {
    await db.query(
      "UPDATE chain_tokens SET collection_id = $1 WHERE token_id >= $2 AND token_id < $2 + $3",
      [collectionId.toString(), firstTokenId.toString(), trackCount.toString()]
    );
  },

  async MarketItemSold(db, { tokenId, buyer, amount, totalPrice }, log) {
    const { rows } = await db.query(
      "UPDATE chain_tokens SET supply = supply - $2 WHERE token_id = $1 RETURNING artiste_address",
      [tokenId.toString(), amount.toString()]
    );
    await recordPurchase(db, log, "primary", tokenId, buyer, rows[0]?.artiste_address, amount, totalPrice);
  },

  async MarketItemWithdrawn(db, { tokenId, amount }) {
    await db.query("UPDATE chain_tokens SET supply = supply - $2 WHERE token_id = $1", [tokenId.toString(), amount.toString()]);
  },

  async MarketItemPriceUpdated(db, { tokenId, newPrice }) {
    await db.query("UPDATE chain_tokens SET price_wei = $2 WHERE token_id = $1", [tokenId.toString(), newPrice.toString()]);
    // Keep the catalogue price the apps display in sync with the chain
    await db.query("UPDATE music SET price_wei = $2, price = $3 WHERE token_id = $1", [
      tokenId.toString(),
      newPrice.toString(),
      formatEther(newPrice),
    ]);
  },

  async ResaleListed(db, { listingId, seller, tokenId, amount, price }) {
    await db.query(
      `INSERT INTO chain_resale_listings (listing_id, seller_address, token_id, amount, price_wei)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (listing_id) DO NOTHING`,
      [listingId.toString(), lower(seller), tokenId.toString(), amount.toString(), price.toString()]
    );
  },

  async ResaleSold(db, { listingId, buyer, amount, totalPrice }, log) {
    const { rows } = await db.query(
      `UPDATE chain_resale_listings SET amount = amount - $2, active = (amount - $2) > 0
       WHERE listing_id = $1 RETURNING token_id, seller_address`,
      [listingId.toString(), amount.toString()]
    );
    if (rows[0]) {
      await recordPurchase(db, log, "resale", BigInt(rows[0].token_id), buyer, rows[0].seller_address, amount, totalPrice);
    }
  },

  async ResaleCancelled(db, { listingId }) {
    await db.query("UPDATE chain_resale_listings SET active = false WHERE listing_id = $1", [listingId.toString()]);
  },

  async TradeOfferCreated(db, args, log) {
    await db.query(
      `INSERT INTO chain_trade_offers (trade_id, maker_address, taker_address, offered_token_id, offered_amount,
                                       requested_token_id, requested_amount, created_tx_hash, created_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (trade_id) DO NOTHING`,
      [
        args.tradeId.toString(), lower(args.maker), lower(args.taker),
        args.offeredTokenId.toString(), args.offeredAmount.toString(),
        args.requestedTokenId.toString(), args.requestedAmount.toString(),
        log.transactionHash, log.blockNumber.toString(),
      ]
    );
  },

  async TradeOfferAccepted(db, { tradeId }) {
    await db.query("UPDATE chain_trade_offers SET status = 'accepted' WHERE trade_id = $1", [tradeId.toString()]);
  },

  async TradeOfferCancelled(db, { tradeId }) {
    await db.query("UPDATE chain_trade_offers SET status = 'cancelled' WHERE trade_id = $1", [tradeId.toString()]);
  },

  async TransferSingle(db, { from, to, id, value }) {
    await moveBalance(db, from, to, id, value);
  },

  async TransferBatch(db, { from, to, ids, values }) {
    for (const [i, id] of ids.entries()) await moveBalance(db, from, to, id, values[i]);
  },
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function moveBalance(db, from, to, tokenId, amount) {
  const change = (address, delta) =>
    db.query(
      `INSERT INTO token_balances (address, token_id, amount) VALUES ($1, $2, $3)
       ON CONFLICT (address, token_id) DO UPDATE SET amount = token_balances.amount + EXCLUDED.amount`,
      [lower(address), tokenId.toString(), delta]
    );
  // Mints come from the zero address and burns go to it; neither is a real holder
  if (from !== ZERO_ADDRESS) await change(from, (-amount).toString());
  if (to !== ZERO_ADDRESS) await change(to, amount.toString());
}

function recordPurchase(db, log, kind, tokenId, buyer, seller, amount, totalPrice) {
  return db.query(
    `INSERT INTO purchases (tx_hash, log_index, kind, token_id, buyer_address, seller_address, amount, total_price_wei, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [
      log.transactionHash, log.logIndex, kind, tokenId.toString(), lower(buyer), seller ?? null,
      amount.toString(), totalPrice.toString(), log.blockNumber.toString(),
    ]
  );
}

/**
 * The listing fee is the mint transaction's value (the contract requires it exactly; owner
 * mints pay nothing). An album mints many tokens in one transaction, so it's fetched once.
 */
async function recordMintFee(db, artiste, log) {
  const { rows } = await db.query("SELECT 1 FROM chain_mints WHERE tx_hash = $1", [log.transactionHash]);
  if (rows[0]) return;
  const tx = await publicClient.getTransaction({ hash: log.transactionHash });
  await db.query(
    "INSERT INTO chain_mints (tx_hash, artiste_address, fee_wei, block_number) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [log.transactionHash, lower(artiste), tx.value.toString(), log.blockNumber.toString()]
  );
}

const jsonArgs = (args) => JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function getCursor() {
  const { rows } = await pool.query("SELECT last_block FROM indexer_state WHERE id = $1", [STATE_ID]);
  return rows[0] ? BigInt(rows[0].last_block) : config.INDEXER_START_BLOCK - 1n;
}

/** Indexes every confirmed block not yet processed. Returns the number of events applied. */
export async function syncOnce() {
  // viem caches the block number for a few seconds by default; the indexer needs the real head
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const safeHead = head - config.INDEXER_CONFIRMATIONS + 1n;
  let from = (await getCursor()) + 1n;
  let applied = 0;

  while (from <= safeHead) {
    const to = from + config.INDEXER_BATCH_BLOCKS - 1n < safeHead ? from + config.INDEXER_BATCH_BLOCKS - 1n : safeHead;
    const logs = await publicClient.getContractEvents({
      address: config.CONTRACT_ADDRESS,
      abi: nodewaveAbi,
      fromBlock: from,
      toBlock: to,
    });

    // Events and the cursor commit together, so a crash never skips or double-applies a block range
    await withTransaction(async (client) => {
      for (const log of logs) {
        const { rowCount } = await client.query(
          `INSERT INTO chain_events (tx_hash, log_index, block_number, event_name, args)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [log.transactionHash, log.logIndex, log.blockNumber.toString(), log.eventName, jsonArgs(log.args)]
        );
        if (rowCount && handlers[log.eventName]) {
          await handlers[log.eventName](client, log.args, log);
          applied += 1;
        }
      }
      await client.query(
        `INSERT INTO indexer_state (id, last_block) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block`,
        [STATE_ID, to.toString()]
      );
    });
    from = to + 1n;
  }
  return applied;
}

/** Polls the chain until stopped. Errors are logged and retried on the next tick. */
export function startIndexer() {
  let timer;
  let stopped = false;
  const tick = async () => {
    try {
      await syncOnce();
    } catch (err) {
      console.error("Indexer sync failed:", err.shortMessage || err.message);
    }
    if (!stopped) timer = setTimeout(tick, config.INDEXER_POLL_MS);
  };
  tick();
  console.log(`Indexing NodeWave events at ${config.CONTRACT_ADDRESS}`);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
