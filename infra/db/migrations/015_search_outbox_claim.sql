-- Migration 015: outbox claim column for the background drain worker.
--
-- The inline processOutboxAsync handles API-initiated reindex (create/title/move/
-- delete — including the SYNCHRONOUS permission-revocation path). But page BODY is
-- written by the collab server (Y.Doc store), which only ENQUEUES a search_outbox
-- 'upsert' — nothing drained those rows, so full-text body search never updated.
-- A background worker now drains them. claimed_at lets multiple API instances claim
-- disjoint batches (UPDATE ... FOR UPDATE SKIP LOCKED) and re-claim rows a crashed
-- worker abandoned after a stale timeout. Reliability is intentional: "body appears
-- in search" is core, so a failed reindex is retried, never dropped.
ALTER TABLE search_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS search_outbox_claim_idx ON search_outbox (claimed_at, created_at);
GRANT UPDATE ON TABLE search_outbox TO app;
