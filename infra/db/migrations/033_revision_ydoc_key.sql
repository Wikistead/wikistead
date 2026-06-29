-- Migration 033: offload revision ydoc bytes to object storage (#113 / ADR-062).
--
-- New revisions store their Y.Doc bytes in the StorageDriver (S3-compatible) and keep only a
-- tenant-namespaced pointer here; the inline `ydoc` BYTEA is no longer written for new rows.
-- Legacy rows keep their inline `ydoc` and are read via dual-read (ydoc_key ?? ydoc) until an
-- optional backfill converges them. So `ydoc` becomes nullable, and a CHECK guarantees every
-- row still has exactly one source of bytes (inline OR key) — never a row with neither.
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS ydoc_key TEXT;
ALTER TABLE revisions ALTER COLUMN ydoc DROP NOT NULL;
ALTER TABLE revisions ADD CONSTRAINT revisions_ydoc_source_present
  CHECK (ydoc IS NOT NULL OR ydoc_key IS NOT NULL);
