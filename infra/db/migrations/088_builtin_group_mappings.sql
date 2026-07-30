-- Migration 088: a group→role mapping can name a BUILT-IN role (#497, unlocked by #536).
--
-- 081 required role_id (custom-only) because a built-in had no row anywhere to point at. #536/086
-- gave built-in GRANTS a home — a role_assignments row keyed by builtin_capability — so the mapping
-- table gets the same treatment: exactly one of role_id / builtin_capability names what the group
-- confers. The mapping still OWNS its assignment (ADR-183 §1); only which column identifies the
-- role changes, mirroring 086's shape.
ALTER TABLE group_role_mappings ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE group_role_mappings ADD COLUMN builtin_capability TEXT;
ALTER TABLE group_role_mappings ADD CONSTRAINT group_role_mappings_kind
  CHECK ((role_id IS NULL) <> (builtin_capability IS NULL));
-- 081's UNIQUE has role_id in it, and NULLs never collide in a plain UNIQUE — the built-in twin is a
-- partial unique index, exactly like role_assignments_builtin_unique (086).
CREATE UNIQUE INDEX group_role_mappings_builtin_unique
  ON group_role_mappings (tenant_id, group_name, builtin_capability, resource_type, resource_id)
  WHERE builtin_capability IS NOT NULL;
