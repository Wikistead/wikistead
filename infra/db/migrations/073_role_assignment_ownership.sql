-- Migration 073: role-assignment tuple OWNERSHIP (#420 / ADR-164 increment 3,).
--
-- The unassign path must not delete a leaf tuple another source still produces (the
-- reference-count condition). Ownership disambiguates the DIRECT-GRANT case: at expansion time the
-- engine records which capability leaves THIS assignment actually created (a tuple that already
-- existed — e.g. a prior direct grant — is NOT owned and is never deleted by unassign). The
-- other-ROLE case is resolved by counting live assignments at unassign time.
ALTER TABLE role_assignments ADD COLUMN owned_capabilities TEXT[] NOT NULL DEFAULT '{}';
