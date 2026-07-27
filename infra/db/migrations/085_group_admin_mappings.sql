-- Migration 085: declarative IdP group -> TENANT ADMIN mapping (#497 / ADR-183 §2b).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT for the new table in this file.
--
-- Why a table of its own rather than a row in group_role_mappings (081): that table's role_id is a NOT
-- NULL FK to `roles`, and tenant admin is a BUILT-IN — it has no roles row. Admin is also not conferred
-- the way a custom role is (no role_assignments row, no capability bundle): it is `members.role='admin'`
-- plus the `tenant#admin` FGA tuple. Forcing it into the role-mapping table would mean a synthetic roles
-- row that the assign path could hand out like any other, which is exactly the blast radius ADR-183
-- warned about.
--
-- The mapping is DECLARATIVE ONLY: it never becomes an FGA leaf. ADR-183 rejected option (a) — adding
-- [group#member] to tenant#admin in the model — because a compromised or merely sloppy IdP group would
-- then confer tenant admin with NO action on our side and no record of who got it. Instead admin is
-- MATERIALISED per user at login / SCIM group change, leaving `members.admin_origin` (081) as the
-- provenance marker, so a hand-appointed admin is never demoted by a vanishing IdP group and a
-- materialised one can be found and revoked. `admin_origin` is why this table can stay this small.
CREATE TABLE group_admin_mappings (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  group_name TEXT NOT NULL,          -- the IdP group NAME, same source members.groups[] carries (#111)
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, group_name)
);
CREATE INDEX group_admin_mappings_tenant ON group_admin_mappings (tenant_id);

ALTER TABLE group_admin_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_admin_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_admin_mappings
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_admin_mappings TO app;

-- The drift reconcile (ADR-183 §2b, required at v1) scans materialised admins across tenants; without
-- this it is a sequential scan of members per tenant on every sweep.
CREATE INDEX IF NOT EXISTS members_admin_origin_mapping
  ON members (tenant_id) WHERE role = 'admin' AND admin_origin = 'mapping';
