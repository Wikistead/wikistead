-- #554 S6 / ADR-197 §6: group trust is a PER-CONNECTION attribute. The login upsert persists
-- claims.groups into members.groups, and default-role / admin-mapping / the drift sweep all read
-- that column — so an untrusted connection asserting `groups: ["wiki-admins"]` could take tenant
-- admin without touching group#member. trust_groups=false is the default for NEW connections;
-- the backfill sets TRUE on every existing row (= the legacy connection, today's exact behavior).
-- The platform connection is env-injected (no row) and stays trusted: it is the deployment
-- operator's own IdP.
ALTER TABLE tenant_oidc ADD COLUMN trust_groups BOOLEAN NOT NULL DEFAULT false;
UPDATE tenant_oidc SET trust_groups = true;
ALTER TABLE tenant_saml ADD COLUMN trust_groups BOOLEAN NOT NULL DEFAULT false;
UPDATE tenant_saml SET trust_groups = true;
