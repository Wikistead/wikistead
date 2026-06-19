-- Migration 012: per-tenant OIDC config + members (P1.1 real OIDC login).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- Identity vs membership (the P1.1 security invariant): authenticating at a
-- tenant's IdP proves IDENTITY only. AUTHORIZATION to enter the tenant is a
-- separate grant — a row in `members` (+ the FGA tenant#member tuple). Login
-- upserts an EXISTING member's profile; it never creates membership. Membership
-- is granted only by Cloud signup (P1.2) or invite (P1.4). "Can authenticate"
-- must never imply "can enter".

-- ── tenant_oidc: one IdP config per tenant ──────────────────────────────────
-- Read server-side only (the /auth/login flow), under the tenant's RLS context.
-- client_secret is stored ENCRYPTED AT REST (AES-GCM, app key from env) — the
-- column holds base64(nonce||ciphertext||tag), NULL for public/PKCE-only clients.
-- The encrypt/decrypt helper lands with the auth routes (C3); dev config is
-- seeded there from .env. The secret is NEVER sent to the browser.
CREATE TABLE tenant_oidc (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  issuer             TEXT NOT NULL,                 -- OIDC issuer URL (discovery base)
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT,                          -- base64 AES-GCM, NULL = public client
  scopes             TEXT NOT NULL DEFAULT 'openid email profile',
  redirect_uri       TEXT NOT NULL,                 -- exact match enforced in the flow
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

ALTER TABLE tenant_oidc ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_oidc FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_oidc
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_oidc TO app;

-- ── members: provisioned tenant members (the authorization side) ─────────────
-- sub = the IdP subject claim (stable per IdP). Unique within a tenant. role is
-- a coarse app role (refined into the roles UI in P1.4). groups feed FGA
-- group#member and @mentions later.
CREATE TABLE members (
  id           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  sub          TEXT NOT NULL,                       -- IdP subject (OIDC `sub`)
  email        TEXT,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'member',      -- 'admin' | 'member' (coarse; P1.4)
  groups       TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),                            -- composite FK target (future)
  UNIQUE (tenant_id, sub)                            -- natural key for login upsert
);

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE members TO app;
