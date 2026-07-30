-- Migration 089: email_outbox (#547 / ADR-196 §5).
--
-- A GLOBAL processing queue with NO RLS, exactly like search_outbox (004) / audit_outbox (043) /
-- webhook_outbox (054): the cross-tenant drain worker claims rows through the one shared lease
-- primitive (db/outbox-lease.ts, FOR UPDATE SKIP LOCKED) on the shared pool — an RLS'd outbox would
-- claim nothing (#432). Rows are THIN by design: ids and routing only, NEVER subject/body/content —
-- the message is built AT SEND TIME behind the send-time authorization gates (ADR-196 §4), so a row
-- that sits in the queue across a revocation cannot leak anything.
--
-- attempts / next_attempt_at carry the webhook_outbox retry shape: send failures and `not-ready`
-- dispositions share one bounded budget (retry with backoff, then drop with a logged reason — the
-- #482 rule that nothing may poison the queue head). fold_key ((recipient, resource, class), §6)
-- lets the drain gather an immediate row's due siblings and send ONE folded message.
CREATE TABLE IF NOT EXISTS email_outbox (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL,
  member_sub      TEXT NOT NULL,             -- the recipient; address resolved at SEND time (IdP moves are picked up)
  class           TEXT NOT NULL,             -- 'mention' (immediate) | 'digest'
  notification_id TEXT,                      -- immediate: the notifications row this mail is built FROM (ADR-196 §1)
  fold_key        TEXT,                      -- immediate collapse key (§6); NULL for digest (inherently collapsed)
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_outbox_claim_idx ON email_outbox (claimed_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS email_outbox_fold_idx ON email_outbox (fold_key, next_attempt_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_outbox TO app;
