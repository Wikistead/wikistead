-- Migration 005: attachments table.
--
-- Status lifecycle:
--   pending   → client received presigned PUT URL but has not confirmed the upload.
--               Invisible to reads (幽霊添付防止); GC removes after 1 hour.
--   confirmed → client confirmed; S3 object exists; visible in lists and downloads.
--   deleted   → soft-deleted; invisible to reads; S3 delete + physical DB delete
--               fired asynchronously (at-least-once, same pattern as search_outbox).
--
-- size_bytes: populated at confirm time from S3 HeadObject — NOT from client input.
-- Prevents tampering; provides a trustworthy basis for future storage quotas.
--
-- Composite FK (tenant_id, page_id) → pages(tenant_id, id):
-- Enforces same-tenant page reference at DB level, closing the FK-bypasses-RLS gap.

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   BIGINT,           -- NULL until confirmed; set from S3 HeadObject
  s3_key       TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'deleted')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, page_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attachments
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE attachments TO app;
