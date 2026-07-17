-- Migration 072: custom roles (#420 / ADR-164 increment 2) — the role STORE.
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- A role is a tenant-defined, NAMED bundle of atomic capabilities (the ADR-164 §1 vocabulary).
-- FGA stays the single authz truth: no check ever reads these tables — a role only chooses which
-- fixed-relation leaf tuples the assignment write-path (increment 3) writes. `capabilities` is a
-- TEXT[] validated at the API layer against the fixed vocabulary (view/comment/edit/publish/
-- delete/share/settings/moderate); built-in roles (viewer/editor/moderator/manager) are VIRTUAL
-- (reserved names, not rows), so this table holds custom definitions only.
CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  capabilities TEXT[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE roles TO app;

-- PROVENANCE: which role produced which expanded grant (increment 3 writes these alongside the FGA
-- leaf tuples). Lets the UI show "Bob: Recycler" instead of raw relations, and lets a role edit
-- (increment 4) diff/re-expand every assignment. One row per (resource, principal, role).
-- resource_type: 'page' | 'space'. principal: 'user:<sub>' | 'group:<id>#member' (validateGrant's
-- vocabulary — never share_link/user:*; the API layer enforces, the FGA model backstops).
CREATE TABLE role_assignments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  principal     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role_id, resource_type, resource_id, principal)
);
CREATE INDEX role_assignments_resource ON role_assignments (tenant_id, resource_type, resource_id);
CREATE INDEX role_assignments_role ON role_assignments (tenant_id, role_id);

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_assignments
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE role_assignments TO app;
