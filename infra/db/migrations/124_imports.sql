-- Migration 124: the import job row (#712 / ADR-227 §7).
--
-- Import stays SYNCHRONOUS below the threshold — nothing here changes a small vault's path. Above it the
-- request returns 202 and this row is both the QUEUE ENTRY and the PROGRESS/REPORT surface, so a proxy
-- timeout can no longer lose a completed import's report (the §7 failure this exists to fix).
--
-- NO RLS, on purpose and consistent with every other drained queue (search_outbox 004 / audit_outbox 043 /
-- email_outbox 089): the drain claims across tenants on the shared pool with FOR UPDATE SKIP LOCKED, and an
-- RLS'd table answers that claim with zero rows. The consequence is that TENANT ISOLATION ON THE READ PATH IS
-- AN EXPLICIT PREDICATE, not a database guarantee — `GET /spaces/:spaceId/imports/:id` filters on
-- (id, tenant_id, space_id) AND re-checks FGA `edit` on the space, and a cross-tenant read is pinned by test.
-- Rows carry no page content: ids, a status, a count and the report (which names what degraded).
CREATE TABLE imports (
  id             TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id       TEXT NOT NULL,
  executor_sub   TEXT NOT NULL, -- raw OIDC sub: the job creates pages AS this member (authz is unchanged)
  parent_page_id TEXT,
  publish        BOOLEAN NOT NULL DEFAULT FALSE,
  archive_key    TEXT,          -- staged archive in object storage; cleared+deleted when the job settles
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  nodes_total    INTEGER NOT NULL DEFAULT 0,
  nodes_done     INTEGER NOT NULL DEFAULT 0,
  report         JSONB,
  error          TEXT,
  claimed_at     TIMESTAMPTZ,   -- the shared outbox lease (db/outbox-lease.ts)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "One running import per space" (#623's bound, ADR-227 §7) as a STRUCTURE, not a check-then-insert: a
-- read-then-write would let two concurrent uploads both see "nothing running" and both start, which is the
-- exact race the bound exists to prevent. The second INSERT violates this index and the route answers 409.
CREATE UNIQUE INDEX imports_one_active_per_space ON imports (tenant_id, space_id)
  WHERE status IN ('queued', 'running');
-- The drain's claim order (FIFO), and the per-space status list.
CREATE INDEX imports_claim_idx ON imports (created_at) WHERE status = 'queued';
CREATE INDEX imports_space_idx ON imports (tenant_id, space_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE imports TO app;
