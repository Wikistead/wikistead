-- Migration 003: billing columns on tenants + plan_events audit table.

-- Stripe integration columns (nullable: not all tenants have a Stripe customer yet).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;

-- Plan change audit + webhook idempotency.
-- stripe_event_id UNIQUE ensures the same Stripe event is never processed twice.
-- No RLS: this is a global admin table, not tenant-scoped data.
CREATE TABLE IF NOT EXISTS plan_events (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  event_type      TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL UNIQUE,
  old_plan        TEXT,
  new_plan        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON TABLE plan_events TO app;

-- Upgrade dev tenant to pro so local development is not limited by free plan caps.
-- Billing tests explicitly set plan = 'free' when testing limit enforcement.
UPDATE tenants SET plan = 'pro' WHERE slug = 'dev';
