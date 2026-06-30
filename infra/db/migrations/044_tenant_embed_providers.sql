-- Migration 044: per-tenant external-embed provider allowlist (#108 / ADR-071).
--
-- External URL embeds are OFF by default (the owner decision): the allowlist is EMPTY until an
-- operator/admin opts in specific provider hosts. Only an allowlisted host can be server-fetched
-- (after the page-view gate + SSRF guard), so an empty allowlist means no external embed leaves
-- the system — consistent with the "external egress is operator opt-in" stance (#074/#077).
-- The existing tenant_settings GRANT/RLS (migration 019) covers the new column.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS embed_providers TEXT[] NOT NULL DEFAULT '{}';
