-- Migration 001: tenants table and RLS infrastructure.
--
-- RLS RULE: every tenant-scoped table created in a subsequent migration MUST
-- include all four of these statements in the same migration file:
--
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON <t>
--     USING (tenant_id = current_setting('app.tenant_id', TRUE));
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE <t> TO app;
--
-- FORCE ROW LEVEL SECURITY ensures the policy applies even when connected as
-- the table owner. The runtime role (app) is NOSUPERUSER + NOBYPASSRLS, so RLS
-- always applies regardless — FORCE is an additional defence-in-depth layer.

-- Set the default value of the app.tenant_id GUC for every new connection.
-- current_setting('app.tenant_id', TRUE) returns '' rather than raising when unset.
ALTER DATABASE app SET app.tenant_id = '';

-- Ensure schema is accessible to the runtime role (idempotent in PostgreSQL 14-;
-- required in PostgreSQL 15+ where public schema USAGE is no longer PUBLIC by default).
GRANT USAGE ON SCHEMA public TO app;

-- Global tenant registry — NOT tenant-scoped; no RLS.
-- Only the app server reads this via TenantRegistry. Never exposed to tenant users.
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug          TEXT NOT NULL UNIQUE,
  custom_domain TEXT UNIQUE,
  isolation     TEXT NOT NULL DEFAULT 'logical'
                  CHECK (isolation IN ('logical', 'namespace')),
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenants TO app;

-- Migration tracker (superuser writes on apply; app can also insert).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON TABLE schema_migrations TO app;

-- Dev seed (idempotent; safe to run in production — just a no-op if slugs exist).
INSERT INTO tenants (id, slug, plan) VALUES
  ('tenant_dev',  'dev',  'free'),
  ('tenant_acme', 'acme', 'pro')
ON CONFLICT (slug) DO NOTHING;
