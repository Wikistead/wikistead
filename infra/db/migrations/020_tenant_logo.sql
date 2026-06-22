-- Migration 020: tenant logo (Phase 5d-2). Adds the logo object key + content type
-- to tenant_settings. The bytes live in S3 under a server-generated, tenant-scoped
-- key (no user filename in the path); read is public via GET /branding/logo, write
-- is admin + entitlement gated. NULL = no logo (header falls back to the wordmark).

ALTER TABLE tenant_settings ADD COLUMN logo_key TEXT;
ALTER TABLE tenant_settings ADD COLUMN logo_content_type TEXT;
