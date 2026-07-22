-- #464 / ADR-175 (per-viewer page analytics, EE): the durable collection substrate.
--
-- Three tables, slice 1 (schema + reliable drain only — NOT yet wired to any read surface, so nothing is
-- collected until slice 2):
--   1. analytics_outbox — the at-least-once collection queue. An INFRA table like search/audit/webhook
--      outboxes: NO row-level security, drained by the bare-pool lease worker (#432), tenant_id is a plain
--      scoping column. A member view carries the viewer's BARE member sub; a guest/anon view carries NULL
--      (never a durable guest/anon identifier — reviewer condition 2, ADR-175 §2).
--   2. page_view_roster — the MEMBER who-viewed roster (personal data): one row per (page, member, day).
--      FORCE RLS (tenant isolation) — read by the manage-gated dashboard on the RLS-scoped connection, and
--      the drain writes it under withTenantTx (sets app.tenant_id) so the bare-pool worker still honours RLS.
--   3. page_view_daily — the per-(page, day, viewer_class) aggregate counter (members counted as distinct/day
--      via the roster; guests/anon as deduped sessions). FORCE RLS, same rationale.

CREATE TABLE IF NOT EXISTS analytics_outbox (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  day          DATE NOT NULL,
  viewer_class TEXT NOT NULL CHECK (viewer_class IN ('member', 'guest', 'anon')),
  member_sub   TEXT,          -- the viewer's bare member sub for 'member'; NULL for guest/anon
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ,   -- the #432 lease claim marker
  -- member ⟺ named; guest/anon ⟺ anonymous (no durable id ever lands here for a non-member)
  CHECK ((viewer_class = 'member') = (member_sub IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS analytics_outbox_due ON analytics_outbox (created_at) WHERE claimed_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE analytics_outbox TO app;

CREATE TABLE IF NOT EXISTS page_view_roster (
  tenant_id  TEXT NOT NULL,
  page_id    TEXT NOT NULL,
  member_sub TEXT NOT NULL,
  day        DATE NOT NULL,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, page_id, member_sub, day)
);
ALTER TABLE page_view_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_view_roster FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_view_roster
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE page_view_roster TO app;

CREATE TABLE IF NOT EXISTS page_view_daily (
  tenant_id    TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  day          DATE NOT NULL,
  viewer_class TEXT NOT NULL CHECK (viewer_class IN ('member', 'guest', 'anon')),
  views        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, page_id, day, viewer_class)
);
ALTER TABLE page_view_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_view_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON page_view_daily
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE page_view_daily TO app;
