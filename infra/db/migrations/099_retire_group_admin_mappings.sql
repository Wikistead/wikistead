-- #578 / ADR-201 rev3 slice 4: tenant admin is no longer conferred by an IdP group.
--
-- ADR-183 rejected putting a `group#member` leaf on `tenant#admin` and adopted login-time
-- materialisation instead. ADR-201 abolished that too, for ADR-183's own reasons: whoever can edit the
-- group at the identity provider takes the tenant, nothing records who holds it, and revocation lives
-- outside the product.
--
-- The conversion is the whole point. Every member who currently holds admin BECAUSE of a group keeps
-- it — as a manual admin, the same way one granted by hand holds it. Stripping them would answer "how
-- did you get this?" by removing the answer and the access together, and would leave tenants whose
-- only admins came from a group with nobody in charge at all.
--
-- `members.admin_origin` is deliberately NOT dropped here. Its readers go first; the column follows in
-- a later migration. #499 is what happens when a column is dropped while something still selects it.
UPDATE members SET admin_origin = 'manual', updated_at = now()
WHERE role = 'admin' AND admin_origin = 'mapping';

-- The declarations themselves have no meaning once nothing evaluates them.
DELETE FROM group_admin_mappings;
