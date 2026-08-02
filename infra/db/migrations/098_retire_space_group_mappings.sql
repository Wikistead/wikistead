-- #578 / ADR-201 rev3 slice 3: retire SPACE-scope group mappings.
--
-- A space mapping and a space group grant were always the same FGA write: ONE assignment whose
-- principal is `group:<id>#member`. The mapping added a declaration row that OWNED that assignment,
-- which is what the 409s and the drift sweep existed to keep honest. ADR-201 ruled one mechanism, and
-- the grant is the one that survives.
--
-- So this CONVERTS rather than deletes. Each space mapping's assignment becomes an ordinary manual
-- grant — the same principal, the same capabilities, the same FGA tuples, nothing revoked — and the
-- declaration row goes. Nobody loses access; what disappears is the bookkeeping that said "a mapping
-- owns this".
--
-- The consequence is written down because it is real (ADR-201 rev2 named it): a converted row no
-- longer 409s against being replaced, so it now participates in #536's "one principal, one role"
-- replacement the way a hand-made grant does. That is the point of having one mechanism.
--
-- TENANT-scope mappings are NOT touched here — they are slices 4 and 5, and each carries its own
-- conversion.
UPDATE role_assignments SET origin = 'manual'
WHERE id IN (SELECT assignment_id FROM group_role_mappings WHERE resource_type = 'space')
  AND origin = 'mapping';

DELETE FROM group_role_mappings WHERE resource_type = 'space';
