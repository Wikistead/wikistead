-- Migration 048: OIDC enrollment policy + verified enrol-domain registry (#101 / ADR-034 addendum).
--
-- The tenant's `enroll_policy` decides WHO a successful OIDC login auto-enrols (open / domain / groups /
-- invite_only), applied BEFORE the seat cap (which decides how many). The `domain` policy must never
-- trust an email-domain claim un-verified (comment 340/406: the attacker sets domain=victim.com), so an
-- enrol-domain is honoured ONLY once DNS ownership is proven via the SAME DNS-TXT challenge as custom
-- domains (#123 / ADR-065) — `verified_at` is set exclusively by that verification, never by another path.
-- `enroll_allowed_groups` is the allow-list for the `groups` policy (intersected with the NORMALISED
-- claim, #102/#111). Default invite_only = current behaviour (non-members stay out).

ALTER TABLE tenant_settings ADD COLUMN enroll_policy TEXT NOT NULL DEFAULT 'invite_only';
ALTER TABLE tenant_settings ADD COLUMN enroll_allowed_groups TEXT[] NOT NULL DEFAULT '{}';

-- A per-tenant enrol-domain allow-list. `verified_at IS NULL` = pending (published nothing / not proven);
-- it becomes non-null ONLY through the DNS-TXT verification. Not globally UNIQUE (unlike custom_domains):
-- only the domain's real DNS owner can publish the challenge TXT, so a non-owner's row can never verify.
CREATE TABLE enroll_domains (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  domain             TEXT NOT NULL,
  verification_token TEXT NOT NULL,                 -- per-domain unguessable challenge token
  verified_at        TIMESTAMPTZ,                   -- NULL = pending; set ONLY by DNS TXT verification
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain)
);

ALTER TABLE enroll_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE enroll_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON enroll_domains
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE enroll_domains TO app;
