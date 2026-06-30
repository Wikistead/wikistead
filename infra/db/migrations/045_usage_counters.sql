-- Migration 045: metered-usage ledger (#128 / ADR-082).
--
-- The durable, idempotent accounting substrate shared by every metered resource (AI tokens #130,
-- storage bytes #112). Each increment is one row carrying a `source_id` (the originating operation /
-- outbox id); a UNIQUE on (tenant_id, resource, source_id) makes recordUsage idempotent — a retry of
-- the same operation never double-counts, and a failed/charge-less op is simply never recorded. Usage
-- for a billing window = SUM(amount) over (tenant, resource, period_start). RLS-scoped so one tenant
-- never sees or affects another's usage (tenant isolation invariant). Numbers/allowances are a
-- business placeholder and live in the entitlement layer, NOT here — this table only accounts.
CREATE TABLE usage_counters (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  resource     TEXT NOT NULL,                       -- open id: 'ai.tokens' | 'storage.bytes' | …
  period_start DATE NOT NULL,                        -- billing window anchor (monthly); grouping key
  source_id    TEXT NOT NULL,                        -- originating operation/outbox id → idempotency
  amount       BIGINT NOT NULL,                      -- metered amount: requests | tokens | bytes
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One operation increments a given resource AT MOST ONCE (idempotent retry / at-least-once outbox).
  PRIMARY KEY (tenant_id, resource, source_id)
);

-- The hot read is "usage in this window": SUM(amount) for (tenant, resource, period_start).
CREATE INDEX usage_counters_window ON usage_counters (tenant_id, resource, period_start);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
-- USING also serves as the INSERT WITH CHECK (Postgres default), so a row whose tenant_id ≠ the
-- session's app.tenant_id can be neither read, written, nor inserted (cross-tenant blocked).
CREATE POLICY tenant_isolation ON usage_counters
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE usage_counters TO app;
