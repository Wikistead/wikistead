-- Migration 051: page templates (#241 / ADR-110, Accepted).
--
-- A page template is a SNAPSHOT of a page's published Markdown, frozen at save time — editing or
-- deleting the source page never changes a template (no FK cascade; source_page_id is provenance only).
-- Templates live OUTSIDE the page tree, the search index, and the public surface. Authorization is FGA
-- (the `template` type): the row here carries only tenant isolation (RLS) + the scope discriminator; the
-- audience (personal / space / tenant) is expressed by FGA tuples, not by reading these columns for
-- access. Snapshot-not-flag was chosen so a template's lifecycle is decoupled from the origin page.
--
-- RLS is the tenant-isolation substrate AND the namespace-promotion driver's scan key (it decides which
-- tables a physically-promoted tenant copies by walking tenant_isolation policies), so the policy name
-- `tenant_isolation` and the ENABLE+FORCE+GRANT shape MUST match 045_usage_counters.sql exactly.
CREATE TABLE templates (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),          -- RLS anchor (tenant isolation)
  name           TEXT NOT NULL,                                  -- the template's display name (also the seeded page title)
  body_md        TEXT NOT NULL,                                  -- frozen snapshot of the source page's published_md
  source_page_id TEXT,                                           -- provenance ONLY: no FK / no cascade (source may be edited/deleted)
  scope          TEXT NOT NULL CHECK (scope IN ('personal', 'space', 'tenant')), -- audience discriminator (FGA carries enforcement)
  space_id       TEXT,                                           -- set for scope='space'; no FK action (space delete degrades to owner/admin visibility, snapshot stays)
  created_by     TEXT NOT NULL,                                  -- the saver's sub (owner in FGA)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The management list / picker reads a tenant's templates ordered by recency; scope grouping is a client
-- concern but the tenant+scope prefix keeps the common queries indexed.
CREATE INDEX templates_tenant_scope ON templates (tenant_id, scope, created_at DESC);

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
-- USING also serves as the INSERT WITH CHECK (Postgres default), so a row whose tenant_id ≠ the session's
-- app.tenant_id can be neither read, written, nor inserted (cross-tenant blocked). Same shape as 045.
CREATE POLICY tenant_isolation ON templates
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE templates TO app;
