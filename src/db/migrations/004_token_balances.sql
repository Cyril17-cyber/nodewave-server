-- ERC-1155 balances rebuilt from TransferSingle/TransferBatch events, so the API can say
-- which tracks an account owns (through its linked wallets) without per-track RPC calls.
CREATE TABLE token_balances (
  address text NOT NULL,
  token_id numeric(78, 0) NOT NULL,
  amount numeric(78, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (address, token_id)
);
CREATE INDEX token_balances_token_id_idx ON token_balances (token_id);

-- Balances need every transfer since deployment, so index the contract again from the start.
-- Transfers were recorded before without a handler; forget them so they get applied now.
-- Every other event stays in chain_events, which stops it being applied twice.
DELETE FROM chain_events WHERE event_name IN ('TransferSingle', 'TransferBatch');
DELETE FROM indexer_state;
