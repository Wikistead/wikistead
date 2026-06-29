-- Migration 036: pending plan downgrade (grace period) — #131 / ADR-064.
--
-- A downgrade is NOT applied instantly (hostile: members/features cut off the moment you
-- downgrade). Instead the webhook keeps `plan` = the OLD plan and records the pending target
-- here; entitlements stay on the old plan during the grace window. A reconciling batch commits
-- the downgrade once grace elapses (sets plan = pending_plan, clears these). Upgrades apply
-- immediately and clear any pending downgrade (more entitlement is always safe). Nullable:
-- only a tenant mid-downgrade has them set.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pending_plan    TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pending_plan_at TIMESTAMPTZ;
