-- #328 / ADR-140: the publish-boundary abuse filter config (increment 1). Tenant-level moderation policy.
-- Defaults are ALL-PERMISSIVE so self-host has zero behavior change / overhead until an admin opts in
-- (shrink ratio NULL = off; banned words empty). Cloud strict defaults are a post-launch entitlement call
-- (ADR-140 #2), not set here. The existing tenant_settings GRANT/RLS (migration 019) covers these.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_shrink_ratio REAL; -- NULL = mass-delete detection off
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_banned_words TEXT[] NOT NULL DEFAULT '{}';
