-- Migration 041: member external_id for SCIM provisioning idempotency (#134 / ADR-070, EE).
--
-- SCIM provisions members out of band keyed by the IdP's externalId. We store it so a repeated
-- POST for the same user is idempotent (no duplicate member) and a later PATCH/DELETE resolves
-- the right member. SUB ALIGNMENT (the open design point, decided here): a SCIM-provisioned
-- member's `sub` is set to the IdP externalId, which is the SAME subject the IdP later sends as
-- the SAML NameID / OIDC sub at login — so provisioning and login converge on one identity
-- (login still never CREATES membership; SCIM is the only out-of-band provisioning path).
--
-- NULL for non-SCIM members (invite/bootstrap). The partial UNIQUE index enforces one member
-- per (tenant, externalId) only when set. The existing members GRANT (012) covers the column.
ALTER TABLE members ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS members_tenant_external_id_uq
  ON members (tenant_id, external_id) WHERE external_id IS NOT NULL;
