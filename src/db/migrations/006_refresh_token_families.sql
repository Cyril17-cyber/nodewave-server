-- Every refresh token descends from one login; tokens from the same login share a family.
-- Reusing a rotated token now revokes only that family (the session it was stolen from, or
-- that a client bug replayed) instead of signing the user out on every device.
ALTER TABLE refresh_tokens ADD COLUMN family_id text;
UPDATE refresh_tokens SET family_id = 'legacy-' || id;
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
