-- ---------------------------------------------------------------------------
-- Owner-only audio: full tracks are stored privately by the API (never on IPFS).
-- The token's public metadata points at a 30-second preview instead.
-- ---------------------------------------------------------------------------
CREATE TABLE audio_files (
  id text PRIMARY KEY,                 -- sha256 of the file, also its storage key
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  preview_url text NOT NULL,           -- public 30s clip
  metadata_uri text NOT NULL UNIQUE,   -- the token URI to mint with
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE music ADD COLUMN audio_id text UNIQUE REFERENCES audio_files(id);

-- ---------------------------------------------------------------------------
-- Plays, for "recently played" across devices (replaces the unused users.recent)
-- ---------------------------------------------------------------------------
CREATE TABLE plays (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  music_id integer NOT NULL REFERENCES music(id) ON DELETE CASCADE,
  preview boolean NOT NULL DEFAULT false,
  played_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plays_user_recent_idx ON plays (user_id, played_at DESC);

ALTER TABLE users DROP COLUMN recent;

-- ---------------------------------------------------------------------------
-- Trade offers mirrored by the indexer
-- ---------------------------------------------------------------------------
CREATE TABLE chain_trade_offers (
  trade_id numeric(78, 0) PRIMARY KEY,
  maker_address text NOT NULL,
  taker_address text NOT NULL,
  offered_token_id numeric(78, 0) NOT NULL,
  offered_amount numeric(78, 0) NOT NULL,
  requested_token_id numeric(78, 0) NOT NULL,
  requested_amount numeric(78, 0) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled')),
  created_tx_hash text NOT NULL,
  created_block bigint NOT NULL
);
CREATE INDEX chain_trade_offers_maker_idx ON chain_trade_offers (maker_address);
CREATE INDEX chain_trade_offers_taker_idx ON chain_trade_offers (taker_address);
CREATE INDEX chain_resale_listings_token_idx ON chain_resale_listings (token_id) WHERE active;

-- Trade events were recorded before without a handler; re-index so they get applied
DELETE FROM chain_events WHERE event_name IN ('TradeOfferCreated', 'TradeOfferAccepted', 'TradeOfferCancelled');
DELETE FROM indexer_state;
