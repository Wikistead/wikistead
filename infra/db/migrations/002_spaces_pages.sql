-- Migration 002: spaces and pages tables with RLS.
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- Cross-tenant FK hardening: pages uses a composite FK (tenant_id, space_id)
-- → spaces(tenant_id, id) to prevent cross-tenant space_id references at DB level.
-- Postgres FK checks can bypass RLS; the composite key closes that gap.

-- ── spaces ────────────────────────────────────────────────────────────────

CREATE TABLE spaces (
  id         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)          -- required as composite FK target for pages
);

ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spaces
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE spaces TO app;

-- ── pages ────────────────────────────────────────────────────────────────

CREATE TABLE pages (
  id         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  space_id   TEXT NOT NULL,
  -- parent_id reserved for nested pages; composite FK added when implemented.
  parent_id  TEXT,
  title      TEXT NOT NULL DEFAULT '',
  -- content is NOT stored here: Y.Text (Yjs/Hocuspocus) is the canonical source.
  -- TODO(phase: collab): add ydoc BYTEA for Hocuspocus persistence snapshots.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),         -- for future parent_id composite FK
  FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pages
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pages TO app;
