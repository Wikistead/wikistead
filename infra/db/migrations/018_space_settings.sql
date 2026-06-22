-- Migration 018: per-space settings (Phase 5c — space branding accent).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
-- Composite FK (tenant_id, space_id) → spaces(tenant_id, id) ON DELETE CASCADE
-- both hardens cross-tenant references and cleans settings when a space is deleted.

CREATE TABLE space_settings (
  space_id   TEXT NOT NULL,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  -- A preset key (not a raw colour) — see ACCENT_PRESETS in @wikistead/types.
  -- NULL = inherit (tenant ▷ default). The server validates the key on write.
  accent_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id),
  FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE space_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON space_settings
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE space_settings TO app;
