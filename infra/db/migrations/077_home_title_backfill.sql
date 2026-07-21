-- Migration 077: backfill space-home page titles to the SPACE NAME (#364).
--
-- Ruling A (#364) made the stored home title the bare space name — the "… Home / …のホーム"
-- suffix became a viewer-language UI label instead. Only the create/rename paths were changed, so
-- every home created BEFORE that ruling still carries the baked-in suffix, and the title band (which
-- re-applies the label) rendered it twice: "Demo Spaceのホームのホーム". The band now interpolates
-- the space name (never the stored title), and this migration makes the STORED value agree so the
-- surfaces that read it directly — search, pins, breadcrumbs, export — carry the same single string.
--
-- Idempotent and self-limiting: only rows a space actually points at, only where the title differs.
-- Deliberately `= s.name` rather than a suffix-stripping regex — the invariant is "the home title IS
-- the space name", so restating it is both simpler and correct for drifted rows (e.g. a space renamed
-- while its home kept the old name), which a strip-the-suffix rewrite would leave stale.
UPDATE pages p
SET title = s.name
FROM spaces s
WHERE s.home_page_id = p.id
  AND s.tenant_id = p.tenant_id
  AND p.title IS DISTINCT FROM s.name;

-- The title is a SEARCH-indexed field, so a silent DB edit would leave Meilisearch serving the old
-- (suffixed) title. Enqueue a reindex through the TRUSTED path (search_outbox → the drain worker)
-- rather than best-effort — the same rule the runtime write paths follow.
INSERT INTO search_outbox (tenant_id, page_id, operation)
SELECT p.tenant_id, p.id, 'upsert'
FROM pages p
JOIN spaces s ON s.home_page_id = p.id AND s.tenant_id = p.tenant_id
WHERE p.published_at IS NOT NULL   -- drafts are not in the members' candidate set; nothing to refresh
  AND p.deleted_root_id IS NULL;   -- a trashed home has no search doc to update
