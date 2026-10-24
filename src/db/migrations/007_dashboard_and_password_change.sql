-- ---------------------------------------------------------------------------
-- Dashboard: who was paid for each sale, and what each mint cost
-- ---------------------------------------------------------------------------
-- The artiste for primary sales, the listing's seller for resales
ALTER TABLE purchases ADD COLUMN seller_address text;
UPDATE purchases p SET seller_address = t.artiste_address
FROM chain_tokens t WHERE p.kind = 'primary' AND t.token_id = p.token_id;
UPDATE purchases p SET seller_address = l.seller_address
FROM chain_events e JOIN chain_resale_listings l ON l.listing_id = (e.args->>'listingId')::numeric
WHERE p.kind = 'resale' AND e.tx_hash = p.tx_hash AND e.log_index = p.log_index;
CREATE INDEX purchases_seller_idx ON purchases (seller_address);

-- Listing fees paid per mint transaction (one row for a whole album)
CREATE TABLE chain_mints (
  tx_hash text PRIMARY KEY,
  artiste_address text NOT NULL,
  fee_wei numeric(78, 0) NOT NULL,
  block_number bigint NOT NULL
);
CREATE INDEX chain_mints_artiste_idx ON chain_mints (artiste_address);

-- Mints were recorded before without their fee; re-index so they get applied now
DELETE FROM chain_events WHERE event_name = 'MarketItemCreated';
DELETE FROM indexer_state;

-- ---------------------------------------------------------------------------
-- Signed-in password changes are confirmed with an emailed code
-- ---------------------------------------------------------------------------
ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check
  CHECK (purpose IN ('verify_email', 'reset_password', 'change_password'));
