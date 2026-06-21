-- Migration 013: tenant invites (P1.4 — the seat lever activates here).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- An invite is the THIRD and only open-ended membership-grant path (after Cloud
-- signup's provisionTenant and the bounded CE bootstrapFirstAdmin). It is the
-- "explicit grant" side of identity≠membership: authenticating never creates
-- membership; accepting an invite does. All three follow ADR-003 (DB writes
-- first, FGA last, throw → full rollback — never a half member).
--
-- Token discipline (same family as guest tokens / signup session / OIDC state):
--   - short-lived (expires_at), consume-once (status pending→accepted is a single
--     atomic winner), tenant-bound (tenant_id + RLS), role-bound (role), and
--     admin-revocable (status→revoked).
--   - The plaintext token lives ONLY in the emailed link. We store a SHA-256 hash
--     (like API keys), so a DB leak cannot reconstruct a live invite link.
--
-- Acceptance weight (decided, P1.4): an invite grants MEMBERSHIP — permanent,
-- consumes a seat, unlocks tenant content — so it is heavier than a share-link
-- guest grant (temporary, collab-only). If a link leaks, whoever holds it can
-- become a permanent member under their own OIDC identity. This is accepted
-- because: (a) consume-once + TTL + revoke + seat cap bound the blast radius to a
-- single seat, and (b) admins see accepted_sub/email in the member list and can
-- remove an unexpected member immediately (real session revocation, P1.4). A
-- future EE option may REQUIRE the authenticated email to match `email`; today we
-- do not bind, to stay friendly to per-tenant IdPs whose email may differ.
CREATE TABLE invites (
  id            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  token_hash    TEXT NOT NULL,                       -- SHA-256 hex of the plaintext token
  email         TEXT,                                -- intended recipient (send target + display)
  role          TEXT NOT NULL DEFAULT 'member',      -- 'admin' | 'member' (P1.4 two-role model)
  invited_by    TEXT NOT NULL,                       -- sub of the admin who created it
  status        TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'accepted' | 'revoked'
  accepted_sub  TEXT,                                -- IdP subject that accepted (admin-visible)
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),                            -- composite FK target (consistency with members)
  UNIQUE (token_hash),                               -- global natural key for accept lookup
  CONSTRAINT invites_role_chk   CHECK (role   IN ('admin', 'member')),
  CONSTRAINT invites_status_chk CHECK (status IN ('pending', 'accepted', 'revoked'))
);

-- Listing pending invites + seat counting both filter by (tenant, status).
CREATE INDEX invites_tenant_status_idx ON invites (tenant_id, status);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invites
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invites TO app;
