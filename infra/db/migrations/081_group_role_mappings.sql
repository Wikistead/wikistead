-- Migration 081: declarative group → role mapping + a default role (#497 / ADR-183).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT for the new table in this file.
--
-- The plumbing for "a group confers access" is already end-to-end (#102 groups claim → #111 FGA
-- group#member sync → group-principal role assignments, which FGA resolves LIVE at check time). This
-- migration adds only the DECLARATIVE bookkeeping ADR-183 needs — no new FGA write path.

-- A mapping is a ROW that OWNS a group-principal role assignment (ADR-183 §1). Creating a mapping =
-- creating the assignment through the existing gated assign path with principal group:<id>#member,
-- tagged origin='mapping'; deleting it = the ref-counted unassign. v1 mapped CUSTOM roles only
-- (built-ins were virtual — no roles row); 088 lifts that after #536 gave built-in grants a row shape
-- (role_id XOR builtin_capability, mirroring 086). group_name is the IdP group
-- NAME (the FGA id is a tenant-salted hash of the name — #111 group-sync); a rename mints a new id and
-- orphans the mapping, which the console SURFACES (empty-group badge) but never auto-migrates.
CREATE TABLE group_role_mappings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  group_name    TEXT NOT NULL,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,               -- 'space' | 'tenant'  (page scope is out of v1)
  resource_id   TEXT NOT NULL,
  -- the assignment this mapping owns (role_assignments.id); the mapping's delete removes it via the
  -- unassign path. NULL only transiently between the two writes of one tx.
  assignment_id TEXT REFERENCES role_assignments(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, group_name, role_id, resource_type, resource_id)
);
CREATE INDEX group_role_mappings_tenant ON group_role_mappings (tenant_id);

ALTER TABLE group_role_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_role_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_role_mappings
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_role_mappings TO app;

-- Provenance for role_assignments (ADR-183 §1): which force produced the row. 'manual' (a person
-- assigned it — today's only behaviour, so the default keeps every existing row unchanged), 'mapping'
-- (a group mapping owns it), 'default' (the fallback-role evaluator owns it, §3). The console renders
-- machine-managed rows read-only-with-a-link; the collision rule (§3) is "manual wins": the default
-- evaluator never creates a row where a manual one exists and never deletes a row it does not own.
ALTER TABLE role_assignments ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

-- §2b: a materialised (mapping-conferred) tenant admin must be distinguishable from a hand-appointed
-- one, so the removal step (member no longer carries the group) touches ONLY 'mapping'-origin admins
-- and never demotes a manual admin whose IdP group happens to vanish. 'manual' by default = every
-- existing admin stays manual.
ALTER TABLE members ADD COLUMN IF NOT EXISTS admin_origin TEXT NOT NULL DEFAULT 'manual';

-- §3: the tenant's default/fallback role — a TENANT-scope custom role id (assigned at ('tenant',
-- tenantId)) conferred on a member whom NO mapping matched. NULL = today's behaviour (plain member).
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS default_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
