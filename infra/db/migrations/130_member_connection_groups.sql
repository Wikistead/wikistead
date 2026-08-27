-- Migration 130: per-connection group claims (#858 / #962, ADR-259 §3.8).
--
-- `members.groups` used to be OVERWRITTEN wholesale by every login upsert (session.ts), which was
-- harmless while a member had exactly one way in. ADR-259 §3.1-3.3 made a second way in a real,
-- reachable state, and a second CONNECTION's login now silently erases the first connection's group
-- claim — a member who is Engineering through connection A and signs in through connection B (which
-- asserts no groups, or different ones) loses the Engineering-granted role the moment B's login runs.
--
-- This table is the fix: each (tenant, connection, member) keeps its OWN most-recently-asserted
-- slice, written only by a login through THAT connection (session.ts / saml-auth.ts). `members.groups`
-- becomes the UNION of every slice a member holds — see `unionForMember` / `recordConnectionGroups`
-- in group-sync.ts, which write both together.
--
-- connection_id carries NO foreign key, same reasoning as member_identities (129): the domain spans
-- tenant_oidc, tenant_saml (a different table), and the literal 'platform' — Postgres cannot express
-- a single-column FK across three sources. 'local' never appears here (a password login carries no
-- claims to assert).
--
-- Deletion: removing a member removes their slices (CASCADE, same as member_identities) — a slice
-- naming nobody is not a smaller state, it is a dangling one. A connection's own deletion is an
-- application-level cascade (ADR-259 §3.5's shape), not this table's — the connection-delete route
-- removes this connection's rows in the same transaction it removes the connection.
CREATE TABLE IF NOT EXISTS member_connection_groups (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  connection_id TEXT NOT NULL,
  member_sub    TEXT NOT NULL,
  groups        TEXT[] NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, member_sub),
  FOREIGN KEY (tenant_id, member_sub) REFERENCES members(tenant_id, sub) ON DELETE CASCADE
);

-- The union recompute (every login, and every trust_groups revocation) reads by (tenant, member)
-- across all of that member's connections — the primary key's leading columns do not cover this.
CREATE INDEX IF NOT EXISTS idx_member_connection_groups_member
  ON member_connection_groups (tenant_id, member_sub);

-- A trust_groups revocation (PATCH /admin/connections/:id) reads "which members hold a slice from
-- THIS connection" — again not the primary key's leading columns.
CREATE INDEX IF NOT EXISTS idx_member_connection_groups_connection
  ON member_connection_groups (tenant_id, connection_id);

ALTER TABLE member_connection_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_connection_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_connection_groups;
CREATE POLICY tenant_isolation ON member_connection_groups
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_connection_groups TO app;
