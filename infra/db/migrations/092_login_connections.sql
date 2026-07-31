-- #554 S1 / ADR-197 §1-2: the unit of login becomes a CONNECTION. tenant_oidc / tenant_saml gain
-- minted uuid identities (freshly minted for legacy rows too — review B4: reusing tenant_id would
-- collide across the two tables and publish tenant ids on the unauthenticated login surface).
-- tenant_oidc becomes N-capable (PK moves to id, tenant_id stays as an indexed column); tenant_saml
-- keeps ONE-per-tenant (ADR-197 §1 B5: multi-SAML is deferred until per-connection ACS binding —
-- the uuid PK lands now so ids exist, the tenant uniqueness stays as a constraint).
--
-- DEPLOY ORDER: the server reads sort/bootstrap_eligible with NO undefined-column tolerance —
-- a server running ahead of this migration fails LOUD on the login path (deliberate: silently
-- serving the old single-row auth shape would mask a half-deployed rollout).
--
-- bootstrap_eligible (ADR-197 §2 rev2): an EXPLICIT trust attribute — the migration sets it TRUE
-- only on the legacy tenant-OIDC connection, which is today's exact bootstrap behavior. New
-- connections default false; only connection-creation surfaces may set it.

ALTER TABLE tenant_oidc ADD COLUMN id TEXT;
UPDATE tenant_oidc SET id = gen_random_uuid()::text;
ALTER TABLE tenant_oidc ALTER COLUMN id SET NOT NULL;
ALTER TABLE tenant_oidc DROP CONSTRAINT tenant_oidc_pkey;
ALTER TABLE tenant_oidc ADD PRIMARY KEY (id);
CREATE INDEX tenant_oidc_tenant_idx ON tenant_oidc (tenant_id);
ALTER TABLE tenant_oidc ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_oidc ADD COLUMN bootstrap_eligible BOOLEAN NOT NULL DEFAULT false;
UPDATE tenant_oidc SET bootstrap_eligible = true;

ALTER TABLE tenant_saml ADD COLUMN id TEXT;
UPDATE tenant_saml SET id = gen_random_uuid()::text;
ALTER TABLE tenant_saml ALTER COLUMN id SET NOT NULL;
ALTER TABLE tenant_saml DROP CONSTRAINT tenant_saml_pkey;
ALTER TABLE tenant_saml ADD PRIMARY KEY (id);
ALTER TABLE tenant_saml ADD CONSTRAINT tenant_saml_tenant_unique UNIQUE (tenant_id);
