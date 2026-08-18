-- Migration 125: second-factor recovery codes (#650 / ADR-226 rev2).
--
-- The point of the feature is that a member who loses their authenticator can get back in WITHOUT
-- anyone else being involved — which is why there is no member-count column, no tenant-size predicate
-- and no lapse stamp here. The owner's ruling is explicit: the state is "holds a set" or "does not",
-- and nothing about the workspace's shape may change it (a set that stops working when a colleague
-- joins is a set nobody can rely on).
--
-- STORAGE (ADR-226 §3): the secret is strong instead of the hash being slow. A code is 80 bits, so
-- SHA-256 with no per-row salt is safe here AND makes verification an indexed single-row lookup —
-- one comparison per attempt rather than ten KDF runs, which on a semi-anonymous door would be an
-- exhaustion lever against the shared scrypt pool the password login needs (#644 rev1's finding).
CREATE TABLE member_recovery_codes (
  id          TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_sub  TEXT NOT NULL, -- raw OIDC sub (member identity — no users table)
  code_hash   BYTEA NOT NULL,
  used_at     TIMESTAMPTZ,   -- the single code that was spent
  revoked_at  TIMESTAMPTZ,   -- set-level: re-mint, a sibling being used, or an admin reset
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE lookup path. Verification is `WHERE tenant_id = … AND code_hash = …` and nothing else: no scan
-- over the member's set, so an attempt costs the same whether the member has ten live codes or none.
-- Scoped by tenant because the hash is deterministic — two workspaces could in principle mint the
-- same bytes, and a cross-tenant match would be a code from one workspace opening a door in another.
CREATE UNIQUE INDEX member_recovery_codes_hash_idx ON member_recovery_codes (tenant_id, code_hash);
-- …and the member's own view (count, minted date, used/revoked state — never the codes).
CREATE INDEX member_recovery_codes_member_idx ON member_recovery_codes (tenant_id, member_sub, created_at DESC);

ALTER TABLE member_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_recovery_codes
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_recovery_codes TO app;
