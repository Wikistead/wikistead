-- Migration 039: per-tenant SCIM bearer tokens (#134 / ADR-070). EE.
--
-- The credential layer for SCIM provisioning: an IdP authenticates to the SCIM endpoints with a
-- per-tenant bearer token (separate from member sessions and API keys). Only the sha256 hash is
-- stored; the plaintext is shown once at issue. token_prefix gives O(1) lookup before the constant-
-- time hash compare. revoked_at = soft-delete (a revoked token never authenticates). RLS-scoped.
-- The SCIM endpoints (RFC 7644) that consume these tokens are a separate sub-task.
CREATE TABLE scim_tokens (
  id           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_tokens
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scim_tokens TO app;
