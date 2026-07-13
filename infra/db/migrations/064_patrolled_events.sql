-- #326 / ADR-142 (C-1 patrol): per-event "patrolled" (reviewed) marks on the Recent Changes feed. Tenant-shared
-- moderation state (who/when only — no content). One row per (tenant, feed_event); marking is an idempotent
-- upsert, unmarking is a delete. The "unpatrolled only" feed filter LEFT JOINs this and keeps the NULLs.
-- feed_events ON DELETE CASCADE: a deleted event drops its patrol mark too.
CREATE TABLE IF NOT EXISTS patrolled_events (
  tenant_id      TEXT NOT NULL,
  feed_event_id  TEXT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
  patrolled_by   TEXT NOT NULL,          -- the member sub who marked it
  patrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feed_event_id)
);

-- Tenant isolation via RLS (the migration-060 watches/feed_events pattern).
ALTER TABLE patrolled_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE patrolled_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patrolled_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE patrolled_events TO app;
