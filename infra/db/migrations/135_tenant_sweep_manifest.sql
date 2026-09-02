-- Migration 135: tenant sweep manifest + progress (ADR-252 §1/"Both operations", #810).
--
-- The durable pre-destruction record "Both operations" requires: object ids for OpenFGA, every S3 key
-- a swept row points at, and the search document ids — captured BEFORE the database step runs, because
-- `attachments` cascades from `pages` and the moment the sweep deletes pages the only list of that
-- tenant's S3 keys is gone (storage GC sweeps rows marked deleted, not tenants, and can never find them
-- again once the pointer is gone). Progress is tracked separately so a run killed mid-sweep can resume:
-- which of the five stores (database, OpenFGA, search, storage, sessions) has been verified swept.
--
-- GLOBAL, operator-only — the same isolation shape as `operator_audit_log` (047): RLS enabled + FORCED
-- with NO policy (default-deny for any non-BYPASSRLS role), and the tenant `app` role holds no grants
-- regardless. Only the admin connection the sweep runs with reads or writes these. `tenant_id` is a
-- plain column, not a foreign key: the row must outlive the `tenants` row it names, and the ADR's own
-- derivation the sweep uses to find tables to empty (FK-reachable from `tenants` UNION any
-- `tenant_id`-bearing table) would otherwise hand the sweep its own resume state to delete — named
-- exclusion here, not accidental survival.
CREATE TABLE tenant_sweep_manifests (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id            TEXT NOT NULL,
  operation            TEXT NOT NULL CHECK (operation IN ('reset', 'remove')),
  -- reset's keep-list (spaces whose row, settings and share links survive); always empty for 'remove'
  keep_space_ids       TEXT[] NOT NULL DEFAULT '{}',
  -- tenant:/space:/page:/template:/group: objects the FGA sweep checks tuples against — collected
  -- before deletion because a fresh workspace gets a fresh id and group object ids are a one-way hash
  -- of (tenantId, name), unrecoverable once the row naming the group is gone
  fga_object_ids       TEXT[] NOT NULL,
  -- every storage key a swept row points at, derived from the key-bearing COLUMNS (not a key shape) —
  -- attachments.s3_key, imports.archive_key, members.avatar_image_key, revisions.ydoc_key,
  -- revision_gc_candidates.ydoc_key, space_settings.icon_image_key, tenant_settings.logo_key
  storage_keys         TEXT[] NOT NULL,
  -- page ids to remove from the search index
  search_document_ids  TEXT[] NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_sweep_progress (
  manifest_id     TEXT PRIMARY KEY REFERENCES tenant_sweep_manifests(id),
  database_done   BOOLEAN NOT NULL DEFAULT false,
  fga_done        BOOLEAN NOT NULL DEFAULT false,
  search_done     BOOLEAN NOT NULL DEFAULT false,
  storage_done    BOOLEAN NOT NULL DEFAULT false,
  sessions_done   BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_sweep_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sweep_manifests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tenant_sweep_manifests FROM app;

ALTER TABLE tenant_sweep_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sweep_progress FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tenant_sweep_progress FROM app;
