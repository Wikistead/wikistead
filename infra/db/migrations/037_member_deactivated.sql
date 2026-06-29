-- Migration 037: member deactivation for plan-downgrade seat freeze (#131 / ADR-064).
--
-- When a downgrade commits and the tenant is over the new seat cap, the over-cap members are
-- DEACTIVATED, not deleted (login/edit disabled, data kept; reactivated on re-upgrade) — the
-- reversible freeze the ADR mandates ("commit performs ONLY reversible freezes, never delete").
-- The tenant#member FGA tuple stays; this is a billing freeze, not a membership revocation.
-- NULL = active. The existing members GRANT (migration 012) already covers the new column.
ALTER TABLE members ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
