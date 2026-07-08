-- Migration 055: per-tenant public-surface parent switch (#253 / ADR-113).
--
-- The tenant-level master gate for the anonymous public surface. Default FALSE = fail-safe: a tenant's
-- public pages are UNREACHABLE (every public route 404s uniformly) until an admin explicitly turns the
-- surface on — a structural block against accidental exposure, independent of any per-page public grant.
-- This is a READ-TIME gate (non-destructive): turning it OFF hides all public pages without stripping their
-- view_base@user:* grants, so turning it back ON restores them (like the non-destructive billing freeze).
-- The existing tenant_settings GRANT + RLS (migration 019) already cover this column.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN NOT NULL DEFAULT false;
