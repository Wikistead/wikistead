-- Migration 043: EE compliance audit log + its transactional outbox (#177 / #134 / ADR-070 + ADR-005).
--
-- DURABILITY (operation ⇒ audit row, never best-effort): the audit INTENT is written to
-- audit_outbox in the SAME tx as the authz/compliance operation (enqueueAudit), so it commits
-- atomically with the operation. A reliable drain then appends to audit_log (computing the
-- per-tenant hash chain) — retried on failure, idempotent via source_id. This replaces the
-- fire-and-forget emit() path for audit-grade events.
--
-- audit_outbox: a global processing queue (NO RLS, like search_outbox) — the cross-tenant drain
-- claims rows via FOR UPDATE SKIP LOCKED.
CREATE TABLE IF NOT EXISTS audit_outbox (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL,
  actor       TEXT NOT NULL,            -- 'user:<sub>' | 'operator:<id>' | 'scim' | 'system'
  action      TEXT NOT NULL,            -- e.g. 'member.removed'
  target      TEXT NOT NULL DEFAULT '', -- resource ref, e.g. 'page:<id>'
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_outbox_claim_idx ON audit_outbox (claimed_at, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE audit_outbox TO app;

-- audit_log: the durable, append-only, hash-chained ledger. RLS-scoped (export is tenant#admin
-- only). APPEND-ONLY at the DB level: the app role gets SELECT + INSERT but NOT UPDATE/DELETE, so
-- the runtime cannot rewrite history; the hash chain (prev_hash/hash) additionally detects any
-- tamper/delete/reorder made out of band. seq is the per-tenant monotonic position; source_id
-- (the outbox id) is UNIQUE per tenant so a re-drain is idempotent (no duplicate row).
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  seq         BIGINT NOT NULL,
  source_id   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  at          TIMESTAMPTZ NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, seq),
  UNIQUE (tenant_id, source_id)
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT ON TABLE audit_log TO app;
