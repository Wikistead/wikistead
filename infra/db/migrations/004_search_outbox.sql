-- Migration 004: search outbox for reliable Meili reindex triggers.
--
-- Outbox entries are written in the SAME DB transaction as the FGA/DB change
-- that alters view permissions. This ensures the intent to reindex is recorded
-- even if Meilisearch is temporarily down. Processing is synchronous but
-- non-blocking: API returns on DB commit; Meili failure leaves the entry for
-- retry (future background worker or manual pnpm search:sync).
--
-- Deletion order: outbox entry removed ONLY after Meili confirms success.
-- At-least-once semantics: if the process crashes after Meili but before the
-- delete, the entry is reprocessed. Safe because Meili upsert/delete is idempotent.
--
-- No RLS: this is a global processing table, not tenant-scoped user data.
CREATE TABLE IF NOT EXISTS search_outbox (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON TABLE search_outbox TO app;
