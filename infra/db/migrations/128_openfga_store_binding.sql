-- Migration 128: ADR-253 §3.4 — the deployment's OpenFGA store-binding witness.
--
-- Deployment-global; NOT tenant-scoped; no RLS (see 001_tenants.sql's `tenants` for the same shape —
-- resolution runs before any tenant exists, on a connection that sets no app.tenant_id, so a table
-- under RLS would answer zero rows there and read as "never had a store").
--
-- Resolution INSERTs the first time it binds this deployment to a store; the test-stack rotate/reset
-- paths UPDATE it; the forget-witness operational command (ADR-253 §8②) DELETEs it; every boot reads
-- it. 001_tenants.sql's own precedent (`schema_migrations`, granted SELECT, INSERT only) would fail
-- at the first write here, which is why all four verbs are granted below.
--
-- A single row: `id` is a fixed literal, enforced by the CHECK below rather than left to be refused
-- after the fact, so a restore or a hand-inserted second row cannot even be written, let alone
-- produce two answers about which store this deployment is bound to.
CREATE TABLE IF NOT EXISTS openfga_store_binding (
  id       TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  store_id TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE openfga_store_binding TO app;
