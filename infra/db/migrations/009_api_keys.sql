-- Migration 009: API keys (third principal after member and guest).
--
-- Security invariants:
--   1. key_hash = sha256(plaintext_key) — plaintext never stored.
--   2. revoked_at IS NULL = active key. The application layer MUST include
--      this condition in every lookup; soft-delete does not physically remove rows.
--   3. Partial index on (key_prefix WHERE revoked_at IS NULL) matches the
--      lookup query exactly, preventing revoked-key rows from being index-scanned.
--   4. RLS (tenant_id) enforces tenant isolation at DB level, same as other tables.
--
-- Issued key format: kb_{8-char prefix}_{32-char secret}  (44 chars total)
-- key_prefix = kb_ + first 8 chars, stored for O(1) prefix-based lookup.
CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  owner_user_id  TEXT NOT NULL,     -- raw OIDC sub; FGA principal = user:{owner_user_id}
  name           TEXT NOT NULL,
  key_prefix     TEXT NOT NULL,     -- 'kb_' + 8 chars, used to locate the row quickly
  key_hash       TEXT NOT NULL,     -- hex(sha256(plaintext_key)); never plaintext
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,       -- updated async (non-blocking) on each successful auth
  revoked_at     TIMESTAMPTZ        -- NULL = active; set to now() to revoke (soft-delete)
);

-- Partial index: only active keys are indexed, exactly matching the lookup WHERE clause.
CREATE INDEX idx_api_keys_lookup
  ON api_keys (key_prefix)
  WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE api_keys TO app;
