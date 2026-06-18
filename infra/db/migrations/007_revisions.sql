-- Migration 007: revisions table for page version history.
--
-- Snapshot creation policy:
--   Auto: storeYdoc inserts a revision only when >= REVISION_INTERVAL_MINUTES
--         have elapsed since the last revision (prevents every-debounce flooding).
--   Restore: the restore API always inserts a revision regardless of the interval
--            so the restored state is immediately undoable.
--
-- Storage: ydoc BYTEA = full Y.Doc state copy per revision.
-- TODO(phase: revisions): migrate to StorageDriver(S3) key when total size warrants.
-- TODO(phase: revisions): add pruning (keep last N revisions per page) when count grows.
--
-- pages.ydoc tombstone note: each restore tombstones all current Y.Text characters
-- (delete+insert approach). Yjs retains tombstones permanently, so repeated restores
-- grow pages.ydoc. TODO: Y.Doc GC / compaction when restoration frequency is high.
CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  ydoc        BYTEA NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  created_by  TEXT,           -- "user:{userId}" | "guest:{shareLinkId}" | NULL
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, page_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revisions
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, DELETE ON TABLE revisions TO app;
