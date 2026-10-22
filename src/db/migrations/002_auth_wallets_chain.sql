-- ---------------------------------------------------------------------------
-- Users: normalised emails, no plaintext "passwords" for social accounts
-- ---------------------------------------------------------------------------
UPDATE users SET email = lower(trim(email));
UPDATE users SET provider = 'credentials' WHERE provider IS NULL OR provider = 'null';
-- Social sign-ups previously stored their uuid in the password column
UPDATE users SET password = NULL WHERE provider <> 'credentials';
UPDATE users SET display_picture_url = NULL WHERE display_picture_url = 'null';
UPDATE users SET verified = false WHERE verified IS NULL;
UPDATE users SET uuid = gen_random_uuid()::text WHERE uuid IS NULL;

ALTER TABLE users
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN verified SET NOT NULL,
  ALTER COLUMN verified SET DEFAULT false,
  ALTER COLUMN uuid SET NOT NULL,
  ALTER COLUMN uuid SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN provider SET DEFAULT 'credentials',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_uuid_key ON users (uuid);

CREATE TABLE oauth_accounts (
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_account_id)
);

-- ---------------------------------------------------------------------------
-- One-time codes (hashed, attempt-limited) replace otplinks
-- ---------------------------------------------------------------------------
DROP TABLE otplinks;

CREATE TABLE otp_codes (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);

CREATE TABLE refresh_tokens (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Wallets linked to accounts via Sign-In With Ethereum
-- ---------------------------------------------------------------------------
CREATE TABLE wallets (
  address text PRIMARY KEY CHECK (address = lower(address)),
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_user_id_idx ON wallets (user_id);

CREATE TABLE siwe_nonces (
  nonce text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Catalogue integrity
-- ---------------------------------------------------------------------------
ALTER TABLE playlist
  ADD CONSTRAINT playlist_type_check CHECK (playlist_type IN ('Single', 'EP', 'Album')),
  ADD COLUMN mint_tx_hash text UNIQUE,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE music
  ALTER COLUMN token_id TYPE numeric(78, 0) USING nullif(token_id, '')::numeric,
  ADD COLUMN price_wei numeric(78, 0),
  ADD COLUMN released_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX music_token_id_key ON music (token_id);
CREATE INDEX music_album_id_idx ON music (album_id);
CREATE INDEX music_artiste_id_idx ON music (artiste_id);

-- Favourites move from a text[] column to a join table (no duplicates, real FKs)
CREATE TABLE favorites (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  music_id integer NOT NULL REFERENCES music(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, music_id)
);
INSERT INTO favorites (user_id, music_id)
SELECT DISTINCT u.id, f::integer
FROM users u, unnest(u.favorites) AS f
WHERE f ~ '^[0-9]+$' AND EXISTS (SELECT 1 FROM music m WHERE m.id = f::integer);

-- minted_tracks and purchased_songs are now derived from music / purchases
ALTER TABLE users DROP COLUMN favorites, DROP COLUMN minted_tracks, DROP COLUMN purchased_songs;

-- ---------------------------------------------------------------------------
-- Uploads (who pinned what, so only the uploader can unpin)
-- ---------------------------------------------------------------------------
CREATE TABLE uploads (
  cid text NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('audio', 'image', 'metadata')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cid, user_id)
);

-- ---------------------------------------------------------------------------
-- On-chain state mirrored by the indexer
-- ---------------------------------------------------------------------------
CREATE TABLE indexer_state (
  id text PRIMARY KEY,
  last_block bigint NOT NULL
);

CREATE TABLE chain_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  event_name text NOT NULL,
  args jsonb NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX chain_events_name_idx ON chain_events (event_name);

CREATE TABLE chain_tokens (
  token_id numeric(78, 0) PRIMARY KEY,
  uri text NOT NULL,
  artiste_address text NOT NULL,
  price_wei numeric(78, 0) NOT NULL,
  supply numeric(78, 0) NOT NULL,
  collection_id numeric(78, 0),
  minted_tx_hash text NOT NULL,
  minted_block bigint NOT NULL
);

CREATE TABLE chain_resale_listings (
  listing_id numeric(78, 0) PRIMARY KEY,
  seller_address text NOT NULL,
  token_id numeric(78, 0) NOT NULL,
  amount numeric(78, 0) NOT NULL,
  price_wei numeric(78, 0) NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE purchases (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('primary', 'resale')),
  token_id numeric(78, 0) NOT NULL,
  buyer_address text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  total_price_wei numeric(78, 0) NOT NULL,
  block_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX purchases_buyer_idx ON purchases (buyer_address);
