-- Migration 021: API key scope (Phase 5f). scope restricts a key BELOW its owner's
-- authority (never escalates): 'read' = GET/HEAD only, 'write' = the owner's full
-- authority. NULL = 'write' (backward compatible — existing keys keep working).
-- tenant_settings.api_key_max_scope caps what scope keys may be issued with
-- (admin policy); NULL = 'write' (no cap).
ALTER TABLE api_keys ADD COLUMN scope TEXT;
ALTER TABLE tenant_settings ADD COLUMN api_key_max_scope TEXT;
