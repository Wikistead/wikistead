-- #578 bounce ①: remember the group NAME a grant was made with.
--
-- A group's FGA id is a one-way hash of its name (group-sync.ts), so a listing can only show a human
-- name by REVERSING it against a set of names the product already knows. That set used to be
-- `members.groups` UNION `group_role_mappings.group_name`. Migration 098 removed the second half with
-- the space mappings, and with it the only place that held a name nobody carries yet — so granting to
-- a group the IdP has not produced yet immediately rendered as "unknown group".
--
-- The name belongs on the assignment: that is what was typed, it is scoped to the tenant by the row it
-- sits on, and it disappears when the grant does (a separate name table would accumulate names for
-- grants that no longer exist). NULL for a user principal and for every row written before this.
--
-- Backfill is deliberately absent: the pre-existing rows whose names are recoverable are exactly the
-- ones `members.groups` still resolves, and those already display correctly.
ALTER TABLE role_assignments ADD COLUMN IF NOT EXISTS group_name TEXT;

-- The reverse lookup reads DISTINCT names per tenant; the rows that carry one are a small minority.
CREATE INDEX IF NOT EXISTS role_assignments_group_name_idx
  ON role_assignments (tenant_id, group_name) WHERE group_name IS NOT NULL;
