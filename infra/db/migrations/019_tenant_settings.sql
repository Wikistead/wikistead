-- Migration 019: per-tenant settings (Phase 5d — tenant branding accent + name).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
-- One row per tenant. accent_key/display_name are the tenant-wide branding
-- defaults (the cascade root below space settings). The tenant logo (Phase 5d-2,
-- pending the multipart dependency) will add logo_key/logo_content_type here.

CREATE TABLE tenant_settings (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  -- A preset key (see ACCENT_PRESETS in @wikistead/types), validated on write;
  -- NULL = default. display_name replaces the "wikistead" wordmark in the header.
  accent_key   TEXT,
  display_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_settings TO app;
