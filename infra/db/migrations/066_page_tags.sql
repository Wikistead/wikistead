-- #370 / ADR-145: the frontmatter-tag projection. One row per (page, tag) from the PUBLISHED content's
-- leading YAML frontmatter `tags:` field. DERIVED state (rebuildable from published_md at any time),
-- maintained in the publish tx next to page_links — never authored, never a source of truth.
--
-- SECURITY: this table holds ONLY {page, tag} — NO titles, NO authz data. It is a stage-1 CANDIDATE set:
-- every read (the :::tagged list, tag suggestions) FGA-view-confirms each page at display time, so an
-- unviewable page is absent from list AND count (the search-leak class, ADR-145 §4). Draft tags never
-- appear (published-only); a page delete cascades its rows away.
--
-- `tag` is the NORMALIZED key (lowercased, trimmed — tags are case-insensitively identical, user ruling);
-- `display` keeps the original casing for rendering.
CREATE TABLE IF NOT EXISTS page_tags (
  tenant_id TEXT NOT NULL,
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  display   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, page_id, tag)
);

-- "pages with tag X" lookup.
CREATE INDEX IF NOT EXISTS page_tags_tag_idx ON page_tags (tenant_id, tag);

-- Tenant isolation via RLS (the migration-065 pattern).
ALTER TABLE page_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_tags
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE page_tags TO app;
