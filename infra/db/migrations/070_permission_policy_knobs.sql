-- #399 / ADR-158: creation-policy knobs. RESTRICT-ONLY (they narrow what FGA already allows; never
-- grant), defaults = today's behaviour (zero backfill).
-- 'members' | 'admins' — who may create SHARED spaces (personal auto-create is exempt).
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS space_creation_policy TEXT NOT NULL DEFAULT 'members';
-- 'editors' | 'managers' — who may add pages to this space, BY ANY MEANS (route/duplicate/template/
-- import/MCP all flow through the createPage chokepoint).
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS page_creation_policy TEXT NOT NULL DEFAULT 'editors';
