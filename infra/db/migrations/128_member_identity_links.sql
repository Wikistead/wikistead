-- Migration 128: member identity links (#858 / #959, ADR-259 §3.1 / §3.9).
--
-- A member gains ways in; two members are never merged (§3.1). This table is the mechanism: an
-- identity is ADDED to a member without moving `members.sub` — `local_credentials`, `second_factors`
-- and `password_resets` carry `FOREIGN KEY (tenant_id, member_sub) ... ON DELETE CASCADE` with no
-- `ON UPDATE`, so rewriting a sub would break them, and rewriting it at all is the merge §3.1 refuses.
--
-- KEY IS (tenant_id, connection_id, external_subject), not (tenant_id, issuer, external_subject) —
-- rev 1's shape, withdrawn. Two connections can point at the same issuer (ADR-197 §2 lets a tenant
-- want exactly that); keying on the issuer would either collapse them or key on something the mint
-- never produces. UNIQUE here is part of the decision, not an implementation detail: one upstream
-- identity mapping to two members makes login non-deterministic and the authorization that follows it
-- divergent — an authz one-way door.
--
-- connection_id carries NO foreign key. §3.9 measured the domain at four kinds of value — a
-- tenant_oidc id, a tenant_saml id (a DIFFERENT table), and the literals 'platform' and 'local' — and
-- Postgres cannot exempt rows from a constraint, so a single-column FK across that domain is
-- impossible. The connection-delete cascade that must take a connection's links with it (§3.5) is a
-- separate ticket's application-level concern, not this table's shape.
--
-- Deletion: removing a member removes their links (ON DELETE CASCADE below — ADR-255's shape, so a
-- link never outlives the member it names). A member frozen by seat overage (#131) is NOT deleted —
-- `deactivated_at` is a flag, not a row removal — so a freeze keeps their links exactly as §3.1
-- requires: that state is reversible by design.
CREATE TABLE IF NOT EXISTS member_identities (
  id               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  connection_id    TEXT NOT NULL,
  external_subject TEXT NOT NULL,
  member_sub       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (tenant_id, member_sub) REFERENCES members(tenant_id, sub) ON DELETE CASCADE,
  -- Part of the decision (§3.1), not an implementation detail: one external identity resolves to
  -- exactly one member.
  UNIQUE (tenant_id, connection_id, external_subject)
);

-- A member's links, for account settings (#947) and the connection-delete cascade (#960). The
-- sign-in lookup itself is covered by the UNIQUE constraint's own index above.
CREATE INDEX IF NOT EXISTS idx_member_identities_member
  ON member_identities (tenant_id, member_sub);

ALTER TABLE member_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_identities;
CREATE POLICY tenant_isolation ON member_identities
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_identities TO app;
