-- Migration 113 (#628 / ADR-215 §1): an API key can be given a lifetime.
--
-- Until now the only way a key stopped working was somebody revoking it by hand, so a leaked one lived
-- forever. NULL keeps meaning "does not expire" — this migration adds a column and changes no row, which
-- is the promise ADR-215 makes about existing keys: nothing is silently killed.
--
-- The ceiling sits beside `api_key_max_scope` because it is the same kind of fact: a limit the tenant
-- puts on what its people may mint. A second home for it would be a second place to look.
ALTER TABLE api_keys ADD COLUMN expires_at timestamptz;
ALTER TABLE tenant_settings ADD COLUMN api_key_max_age_days integer;

-- The verification query filters on `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
-- so the partial index that already serves the revocation gate covers this too; `expires_at` is read
-- from the same row, not looked up separately.
COMMENT ON COLUMN api_keys.expires_at IS 'NULL = never expires (#628 / ADR-215)';
COMMENT ON COLUMN tenant_settings.api_key_max_age_days IS 'NULL = no ceiling on requested key lifetime (#628 / ADR-215)';
