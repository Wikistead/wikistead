-- Migration 108: password reset tokens (#568 / ADR-198 §6).
--
-- Same token discipline as every other short-lived secret here (invites, API keys, guest tokens):
-- random 256-bit, plaintext ONLY in the emailed link, SHA-256 at rest, tenant-bound, short-lived,
-- CONSUME-ONCE. A stolen database gives an attacker hashes, not links.
--
-- Consume-once is `used_at`, not a delete: a used row is the record that a reset HAPPENED, which is
-- the first thing an account-takeover investigation looks for. Expired and used rows are swept by
-- the same cleanup that handles invites.
--
-- One row per request, not per member: a member who asks twice gets two live links, and using either
-- invalidates only itself. Rate limiting (not the schema) is what stops a flood.
CREATE TABLE password_resets (
  id          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  member_sub  TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  PRIMARY KEY (id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, member_sub) REFERENCES members(tenant_id, sub) ON DELETE CASCADE
);

CREATE INDEX password_resets_member_idx ON password_resets (tenant_id, member_sub);

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON password_resets
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE password_resets TO app;
