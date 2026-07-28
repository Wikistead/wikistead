-- Migration 086: built-in grants become role_assignments rows (#536 / ADR-188 §6 item 1).
--
-- §6's decision is that a role is a role: built-in and custom are one concept, assigned by one UI and one
-- MECHANISM. The UI half and the shared capability→relation table shipped already; what remained is that a
-- built-in grant still wrote FGA tuples with no row behind it, while a custom-role assignment wrote a row.
-- So every feature built on the row -- provenance (`origin`), the group→role mapping's owned assignment,
-- the re-expansion a role edit performs -- silently applied to custom roles only. A group could be mapped
-- to "Recycler" but not to `view`, which is not a distinction anyone asked for.
--
-- A built-in is still VIRTUAL (072: reserved names, not rows), so it cannot be pointed at by the role_id
-- foreign key. The row therefore carries the capability itself, and exactly one of the two columns is set.
-- What is stored is the capability (`view`, `edit`, `manage`, …) rather than a built-in role NAME, because
-- the capability is what the grant actually is -- the space Members control grants capabilities, and
-- inventing a name here would mean storing something the user never chose.
ALTER TABLE role_assignments ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE role_assignments ADD COLUMN IF NOT EXISTS builtin_capability TEXT;

-- Exactly one of the two. Neither set is a row that expands to nothing; both set is a row whose meaning
-- depends on which column the reader looks at first.
ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_one_kind
  CHECK ((role_id IS NOT NULL) <> (builtin_capability IS NOT NULL));

-- The 072 UNIQUE cannot constrain built-in rows: role_id is NULL there, and NULLs are distinct in a unique
-- constraint, so the same capability could be granted to the same principal any number of times. A partial
-- index over the other four columns restores "one row per (resource, principal, capability)".
CREATE UNIQUE INDEX role_assignments_builtin_unique
  ON role_assignments (tenant_id, builtin_capability, resource_type, resource_id, principal)
  WHERE builtin_capability IS NOT NULL;

-- NO BACKFILL, deliberately. Existing grants are FGA tuples, and FGA remains the single authz truth: a
-- grant made before this migration keeps working and keeps being revocable, because both the listing and
-- the revoke read tuples, which both paths write. Reconstructing rows from tuples would mean inferring
-- intent from leaves -- and a leaf reached through the model rather than written by a grant would become a
-- row asserting a grant nobody made.
