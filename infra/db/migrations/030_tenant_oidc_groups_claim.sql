-- ADR-055 / #102: which id_token claim a tenant's IdP puts the user's groups in. NULL → the
-- default 'groups' (Authentik / Keycloak / Okta). Per-tenant override for IdPs that use 'roles'
-- or a custom claim. The groups feed members.groups → FGA group#member (#111) so group grants
-- (#163) resolve; login never creates membership, so this only affects provisioned members.
ALTER TABLE tenant_oidc ADD COLUMN groups_claim TEXT;
