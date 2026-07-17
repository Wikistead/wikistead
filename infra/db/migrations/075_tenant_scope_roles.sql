-- Migration 075: tenant-scope roles + retire the space-creation policy knob (#445 / ADR-171).
--
-- 1. roles.scope: 'resource' (page/space capability bundles — every pre-existing row) | 'tenant'
--    (tenant-action bundles, vocabulary starting with createSpaces). Fixed at creation; the API
--    validates capabilities against the scope's vocabulary (mutually exclusive sets).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'resource';
ALTER TABLE roles ADD CONSTRAINT roles_scope_check CHECK (scope IN ('resource', 'tenant'));

-- 2. Retire tenant_settings.space_creation_policy (#399 §2 / ADR-158 — superseded): space creation
--    is now the `tenant#space_creator` FGA relation (wildcard = members may create; absent = admins
--    only). Run infra/openfga/migrate-445-space-creator.ts BEFORE this migration on a stateful
--    environment — it rewrites the column's value into the wildcard tuple; this drop is the point of
--    no return.
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS space_creation_policy;
