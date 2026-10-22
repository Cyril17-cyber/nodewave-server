-- Rotation is tracked separately from revocation so a token rotated a moment ago
-- (e.g. two browser tabs refreshing at once) can be honoured within a short grace window,
-- while a logged-out or revoked token never can.
ALTER TABLE refresh_tokens ADD COLUMN rotated_at timestamptz;
