-- Migration 040: per-tenant AI enablement (#130 / ADR-077 — two-stage egress consent).
--
-- ADR-077 requires TWO opt-ins before any AI egress: (a) an operator registers an
-- AIProvider (deployment level), and (b) a tenant ADMIN enables AI for THIS tenant
-- (tenant level). This column is (b). Default FALSE = fail-safe: a tenant sends nothing
-- to a provider until its admin explicitly opts in, even when the plan entitles AI and a
-- provider is configured. Turning it off stops further egress (read fresh, not cached).
-- The existing tenant_settings GRANT + RLS (migration 019) already cover this column.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false;
