-- #322 / ADR-133 §6 (increment ②, inert index slice): the internal-link edge index. One row per outbound
-- reference a page's PUBLISHED content makes to another page. It is a DERIVED index (rebuildable from
-- published_md at any time) that backs the future 2-hop "Related" query + graph view — cheaper than the
-- on-the-fly LIKE/regex scan getBacklinks does today.
--
-- SECURITY: this table holds ONLY the edge shape {from, to, type} — NO title, NO authz data. Nothing reads
-- it yet (the view-filtered 2-hop query is the next slice); when it does, BOTH endpoints are view-filtered
-- so a dead/cross-space/non-viewable target simply yields no node (existence-hiding, ADR-133 §6). Populated
-- from published content only (draft edges never appear); refreshed on every publish; a page delete cascades
-- its outbound edges away.
--
-- Edge `type`: 'link' (a `/p/<id>` markdown link) | 'embed' (a `:::embed-page` body id) today; 'tag' (#324)
-- and 'autolink' (#224, a DERIVED display-only edge) slot in later without a schema change.
CREATE TABLE IF NOT EXISTS page_links (
  tenant_id     TEXT NOT NULL,
  from_page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id    TEXT NOT NULL,  -- NOT an FK: the target may be dangling / cross-space / not-yet-created; the
                                -- 2-hop query view-filters both ends, so a dead edge is simply invisible.
  type          TEXT NOT NULL,  -- 'link' | 'embed' | 'tag' | 'autolink'
  PRIMARY KEY (tenant_id, from_page_id, to_page_id, type)
);

-- Reverse lookup (who links to X) for backlinks / 2-hop fan-in.
CREATE INDEX IF NOT EXISTS page_links_to_idx ON page_links (tenant_id, to_page_id);

-- Tenant isolation via RLS (the migration-060/064 pattern).
ALTER TABLE page_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_links
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE page_links TO app;
