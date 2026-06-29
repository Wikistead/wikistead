-- Migration 038: per-tenant SAML SP config (#135 / ADR-067). EE; mirrors tenant_oidc.
--
-- One IdP config per tenant. The IdP signing cert is a SECRET (AES-GCM encrypted, like the OIDC
-- client secret; SOPS+age for the key, #147) — NEVER plaintext, NEVER returned on read. The SP
-- (ACS callback + signature/XSW/replay validation via @node-saml/node-saml) is a separate sub-task;
-- this is the config registry + the issuance gate (login is only attempted when enabled + entitled).
-- RLS-scoped (tenant isolation). enabled defaults FALSE — a half-configured IdP can't take effect.
CREATE TABLE tenant_saml (
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  idp_entity_id  TEXT NOT NULL,                 -- IdP entityID (assertion issuer)
  sso_url        TEXT NOT NULL,                 -- IdP SSO endpoint (SP-initiated redirect/POST)
  idp_cert_enc   TEXT NOT NULL,                 -- IdP signing cert (PEM), AES-GCM encrypted
  sp_entity_id   TEXT NOT NULL,                 -- our SP entityID (= assertion audience)
  acs_url        TEXT NOT NULL,                 -- our ACS URL (= assertion recipient)
  attr_email     TEXT,                          -- SAML attribute → email (NULL = sensible default)
  attr_name      TEXT,                          -- SAML attribute → display name
  attr_groups    TEXT,                          -- SAML attribute → groups (coerced/bounded like #102)
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

ALTER TABLE tenant_saml ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_saml FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_saml
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_saml TO app;
