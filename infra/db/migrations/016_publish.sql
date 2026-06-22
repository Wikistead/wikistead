-- Migration 016: published version (draft/publish model).
--
-- Two states per page:
--   draft     = pages.ydoc (the live collaborative Yjs doc, autosaved by collab).
--   published = a snapshot promoted by an explicit POST /pages/:id/publish.
--
-- Viewers (and search / export / public render) read the PUBLISHED content, never
-- the live draft — so in-progress edits never leak until published. published_md is
-- the denormalized published body (single fast source for those read paths);
-- published_revision_id points at the revision that is currently live (a soft
-- pointer — no FK, so revision pruning is never blocked and a page delete removes
-- the row anyway). NULL columns = never published yet.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS published_md          TEXT,
  ADD COLUMN IF NOT EXISTS published_revision_id TEXT,
  ADD COLUMN IF NOT EXISTS published_at          TIMESTAMPTZ;

-- pages already grants UPDATE to app; no new grant needed.
