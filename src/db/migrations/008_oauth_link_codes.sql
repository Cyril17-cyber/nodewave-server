-- ---------------------------------------------------------------------------
-- Signing in to an existing account with a provider that doesn't vouch for the
-- email (Spotify) is confirmed with a code emailed to that account. The link
-- token ties the code to the browser that started the sign-in.
-- ---------------------------------------------------------------------------
CREATE TABLE pending_oauth_links (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
