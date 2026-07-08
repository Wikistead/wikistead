-- Migration 054: outbound webhooks (#228 / ADR-108, Accepted).
--
-- webhooks: tenant-scoped subscriptions (RLS, admin-managed like api_keys). secret_enc is the HMAC signing
-- secret ENCRYPTED at rest (secret-crypto.ts) — it must be readable to sign, so it is NOT hashed like an
-- API key; it is never returned after creation. event_filter NULL = all event types. auto-disable flips
-- active=false after N consecutive delivery failures (failure_count). RLS name + ENABLE/FORCE/GRANT match
-- 045_usage_counters.sql (the namespace-promotion driver scans tenant_isolation policies).
CREATE TABLE IF NOT EXISTS webhooks (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  url           TEXT NOT NULL,
  secret_enc    TEXT NOT NULL,                 -- encrypted HMAC secret (never plaintext, never returned)
  event_filter  TEXT[],                        -- NULL = all events; else an allowlist of DomainEvent types
  active        BOOLEAN NOT NULL DEFAULT TRUE,  -- auto-disabled after N consecutive failures
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_tenant_idx ON webhooks (tenant_id, active);
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhooks
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhooks TO app;

-- webhook_outbox: a GLOBAL processing queue (NO RLS, like audit_outbox / search_outbox) — the cross-tenant
-- delivery worker claims rows via FOR UPDATE SKIP LOCKED. The intent is enqueued IN the operation's tx
-- (enqueueWebhookOutbox), so a commit-then-crash still delivers (at-least-once; idempotent via id).
-- payload is the THIN event body (ids/type/actor/timestamp ONLY — never title/content). next_attempt_at
-- drives exponential backoff; attempts caps the retries before the row is dropped and the hook disabled.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_outbox_claim_idx ON webhook_outbox (claimed_at, next_attempt_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhook_outbox TO app;
