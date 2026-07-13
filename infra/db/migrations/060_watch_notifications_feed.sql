-- Migration 060: watch / notifications / cross-space feed (#320 / ADR-126).
--
-- Three tenant-RLS tables (the 057 member_pins pattern verbatim: all-TEXT ids, tenant_id ON DELETE CASCADE,
-- RLS ENABLE + FORCE + tenant_isolation policy + GRANT). RLS enforces TENANT isolation only; MEMBER isolation
-- (a member must never read/mutate another member's watches or notifications) is an app-level predicate
-- (WHERE member_sub = <caller sub>) on every query, and the READ path additionally re-confirms FGA `view` per
-- event + JOINs the live resource row (the ADR-119 double gate) so a feed/notification never leaks an
-- unviewable change or a stale title.

-- Per-member subscriptions to a page or a space.
CREATE TABLE watches (
  id            TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_sub    TEXT NOT NULL, -- raw OIDC sub (member identity — no users table)
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'space')),
  resource_id   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, member_sub, resource_type, resource_id)
);
CREATE INDEX watches_member_idx ON watches (tenant_id, member_sub);
-- Fan-out lookup: "who watches this resource?" (page-watch OR space-watch on an event).
CREATE INDEX watches_resource_idx ON watches (tenant_id, resource_type, resource_id);

ALTER TABLE watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE watches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON watches
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE watches TO app;

-- The CE in-app event store. THIN rows: ids + type + actor only — NEVER titles or content (titles resolve at
-- display time from the live rows, so a stale event can't leak a renamed/deleted title). The feed is a WINDOW
-- (retention GC), not an archive (audit/EE is the archive).
CREATE TABLE feed_events (
  id         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  page_id    TEXT,          -- the most-specific resource (gate 1 authority when non-NULL)
  space_id   TEXT,          -- list filter only; NEVER the gate authority for a page event
  actor      TEXT NOT NULL, -- opaque actor string: user:<sub> | guest:<shareLinkId> | anon:<hash> (C-6)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feed_events_recent_idx ON feed_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX feed_events_space_recent_idx ON feed_events (tenant_id, space_id, created_at DESC, id DESC);

ALTER TABLE feed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feed_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE feed_events TO app;

-- Per-member inbox (fan-out rows). ON DELETE CASCADE on event_id is load-bearing: the retention GC deletes
-- feed_events and the cascade removes their notifications (no FK violation, no orphan).
CREATE TABLE notifications (
  id         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_sub TEXT NOT NULL,
  event_id   TEXT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_member_idx ON notifications (tenant_id, member_sub, created_at DESC, id DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notifications TO app;
