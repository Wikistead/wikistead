-- Migration 057: member pins (#284 / ADR-119) — per-member pinned spaces + pages.
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
-- All id columns are TEXT (every id in this codebase is gen_random_uuid()::text and
-- the RLS predicate current_setting('app.tenant_id', TRUE) returns text — a uuid
-- column would break the tenant-isolation comparison; authz-critical).
--
-- RLS enforces TENANT isolation only. MEMBER isolation (a member must never read
-- or mutate another member's pins) is an app-level predicate: every pin query
-- carries WHERE member_sub = <caller's OIDC sub> (the api_keys.owner_user_id
-- pattern). Display additionally re-confirms FGA `view` per pin and JOINs the
-- live resource row, so a stale pin never leaks a title (ADR-119 double gate).

CREATE TABLE member_pins (
  id            TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_sub    TEXT NOT NULL, -- raw OIDC sub (member identity — no users table)
  resource_type TEXT NOT NULL CHECK (resource_type IN ('space', 'page')),
  resource_id   TEXT NOT NULL,
  position      INT  NOT NULL DEFAULT 0, -- order within (member, resource_type)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, member_sub, resource_type, resource_id)
);

CREATE INDEX member_pins_member_idx ON member_pins (tenant_id, member_sub, resource_type, position);

ALTER TABLE member_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_pins
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_pins TO app;
