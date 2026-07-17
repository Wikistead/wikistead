-- #437 / ADR-167: delete_mode — which DELETION PATHWAYS exist (reversibility policy). It never
-- changes WHO may delete (the delete verb / manage superset gates hold in every mode — pinned).
-- 'trash_only' (default = #411 exactly as shipped) | 'both' | 'direct_only'.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS delete_mode TEXT NOT NULL DEFAULT 'trash_only';
-- NULL inherits the tenant value (resolved = space.delete_mode ?? tenant.delete_mode ?? 'trash_only').
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS delete_mode TEXT NULL;
