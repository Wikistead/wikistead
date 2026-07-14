-- #411 / ADR-153: page trash (soft delete). Bookkeeping columns ONLY — never an authorization input
-- (the FGA `trashed` marker pair is the authority; these drive the trash UI + the retention sweep).
-- Subtree semantics: trashing P stamps P and every descendant with the same deleted_root_id = P (the
-- trash ENTRY is the root; restore/purge operate on that root-keyed row set, never "descendants of P",
-- so an older independent trash root nested inside survives untouched).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_root_id TEXT;

-- The trash listing (per space, roots only) and the retention sweep both key on these.
CREATE INDEX IF NOT EXISTS pages_trash_root_idx ON pages (deleted_root_id) WHERE deleted_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_trash_space_idx ON pages (space_id, deleted_at) WHERE deleted_at IS NOT NULL;
