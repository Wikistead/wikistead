-- Migration 087: tenant login-method preferences (#537 / ADR-195 §1 + ruling 4).
--
-- The per-IdP `enabled` flags live with their configs (tenant_oidc / tenant_saml); what has no home
-- is the tenant's stance on the DEPLOYMENT's shared platform IdP. Ruling 4: a tenant may turn
-- platform login off (SSO enforcement: nobody signs in outside the company IdP) ONLY while an own
-- IdP — OIDC or SAML — is enabled and verified; that condition is enforced by the admin route (and
-- re-checked by the effective-set resolver at read time), not by the schema. Absent row = default:
-- platform login follows the deployment ceiling as before.
CREATE TABLE tenant_login_prefs (
  tenant_id                TEXT NOT NULL REFERENCES tenants(id),
  platform_login_disabled  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

ALTER TABLE tenant_login_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_login_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_login_prefs
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_login_prefs TO app;
