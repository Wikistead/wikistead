-- Migration 046: usage-alert dedup ledger (#128 / ADR-082).
--
-- "Alert once per (tenant, resource, period, threshold)" must hold even when two requests cross the
-- same threshold concurrently (both read the same pre-usage before either records). crossedThresholds
-- already gives once-per-threshold for SEQUENTIAL calls (pre-usage advances); this table is the
-- DURABLE concurrency guard: the PRIMARY KEY makes the first emitter win and every other a no-op
-- (INSERT ON CONFLICT DO NOTHING). RLS-scoped so one tenant's alert state never leaks/collides with
-- another's. threshold is the fraction of the cap (e.g. 0.8, 1.0) stored as the lever value.
CREATE TABLE usage_alerts (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  resource     TEXT NOT NULL,
  period_start DATE NOT NULL,
  threshold    DOUBLE PRECISION NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource, period_start, threshold)
);

ALTER TABLE usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_alerts
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE usage_alerts TO app;
