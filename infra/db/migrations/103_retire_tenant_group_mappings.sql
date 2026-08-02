-- #578 / ADR-201 slice 7: retire the LAST group mapping scope — tenant.
--
-- Migration 098 converted the space mappings; #514 had already made the tenant Roles tab the only place
-- one could still be created, and that surface is what this closes. Same shape as 098, because it is the
-- same fact: a mapping's assignment is the ordinary group assignment the grant path writes, on the very
-- same principal (`group:<id>#member`). Only the declaration row — the thing that claimed to OWN the
-- assignment — goes. Nobody loses a capability, no FGA tuple moves.
--
-- One thing 098 did NOT have to do: carry the group NAME across. A group's FGA id is a one-way hash, so
-- a listing shows a human name only by reversing it against names the product knows, and the mapping row
-- was one of those sources. Dropping these rows without moving the name is exactly the regression #578
-- bounce ① reported for spaces ("unknown group"). Migration 102 gave the assignment somewhere to hold
-- it, so the name moves onto the row that survives.
UPDATE role_assignments a SET group_name = m.group_name
FROM group_role_mappings m
WHERE a.id = m.assignment_id AND m.resource_type = 'tenant' AND a.group_name IS NULL;

UPDATE role_assignments SET origin = 'manual'
WHERE id IN (SELECT assignment_id FROM group_role_mappings WHERE resource_type = 'tenant')
  AND origin = 'mapping';

DELETE FROM group_role_mappings WHERE resource_type = 'tenant';

-- The consequence, written down because it is real and was named in ADR-201 rev2: a converted row no
-- longer 409s against replacement, so it participates in #536's "one principal, one role" sweep the way
-- a hand-made assignment does. That is what having one mechanism means.
--
-- The TABLE stays for now. Its readers (knownGroupNames' union arm, and the machine-managed vestiges in
-- the space grant paths) outlive this migration by design — dropping a column or a table while something
-- still selects from it is how #499 broke fga:resync. The DROP is a later migration, after the readers go.
