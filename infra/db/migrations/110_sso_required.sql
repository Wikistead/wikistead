-- Migration 110: the SSO-required STANCE and its named exemptions (#605 / ADR-210).
--
-- `sso_required` joins the tenant's other method stances (087 platform, 106 local). While it is on and
-- at least one FEDERATED method is effective, the effective set is intersected with {tenant-oidc, saml}
-- and every other row keeps its selection with a reason on the admin surface (ADR-195 §1). It LAPSES —
-- stops biting, changes nothing stored — when no federated method is effective (ADR-210 §2 (d)).
-- DEFAULT FALSE for the same reason 106 is: a stance is a decision, not a migration side effect.
ALTER TABLE tenant_login_prefs ADD COLUMN IF NOT EXISTS sso_required BOOLEAN NOT NULL DEFAULT FALSE;

-- ADR-210 §2 (a): the named members who may still use the password door while the stance bites. A row
-- here is the EXEMPTION; whether the member can actually sign in also needs a local_credentials row
-- (§5: the credential is the only honest witness that a key exists). Revoking the exemption is enough
-- on its own — the key stays but opens nothing.
CREATE TABLE IF NOT EXISTS sso_exemptions (
  tenant_id  TEXT NOT NULL,
  member_sub TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_sub)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sso_exemptions TO app;
ALTER TABLE sso_exemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_exemptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sso_exemptions_tenant ON sso_exemptions;
CREATE POLICY sso_exemptions_tenant ON sso_exemptions
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
