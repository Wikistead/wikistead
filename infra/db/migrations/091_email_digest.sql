-- Migration 091: digest bookkeeping (#547 / ADR-196 §2 §4 §5, S4).
--
-- Per-ITEM disposition without window arithmetic: `notifications.emailed_at` is the ledger of what a
-- digest already carried. Confirmed items are stamped when their digest is built (never re-sent);
-- suppressed/denied items are stamped WITHOUT being included (consumed — revocation is not a race);
-- a `not-ready` item stays unstamped and simply rides the next window. An index on the un-stamped
-- watch rows keeps the producer's existence probe and the builder's gather cheap.
--
-- `members.email_digest_last_at` is the once-a-day guard: the producer (hourly tick, firing only at
-- the configured hour) enqueues for a member at most once per day even if ticks overlap or replicas
-- race (an advisory lock serializes the pass; this column makes it idempotent across passes).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notifications_unemailed_idx ON notifications (tenant_id, member_sub) WHERE emailed_at IS NULL;
ALTER TABLE members ADD COLUMN IF NOT EXISTS email_digest_last_at TIMESTAMPTZ;
