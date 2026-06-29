-- Migration 035: custom-domain verification registry (#123 / ADR-065).
--
-- A Pro tenant brings its own domain (docs.acme.com). Issuing a TLS cert for a caller-supplied
-- host is an abuse/impersonation vector, so a domain is ACTIVATED only after DNS ownership is
-- verified. This table is the verification workflow + the issuance gate: a `Certificate` is only
-- ever created for a `verified` row, and host→tenant resolution only sees a verified domain
-- (mirrored to tenants.custom_domain on verify). UNIQUE(domain) globally = one tenant per domain
-- (no takeover by duplicate claim). The cert-manager Certificate lifecycle is infra (#148).
CREATE TABLE custom_domains (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  domain             TEXT NOT NULL,
  verification_token TEXT NOT NULL,                 -- per-domain unguessable challenge token
  status             TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'verified'
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain),
  UNIQUE (domain)                                   -- a domain belongs to at most one tenant
);

ALTER TABLE custom_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_domains
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE custom_domains TO app;
