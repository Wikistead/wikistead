-- Migration 061: MCP OAuth 2.1 dynamic client registration store (#311 / ADR-131 slice 2).
--
-- RFC 7591 Dynamic Client Registration for the self-hosted MCP authorization server (ADR-131fallback —
-- Authentik has no DCR, so Wikistead fronts /mcp with a thin OAuth 2.1 AS; the Claude connector requires DCR).
-- One tenant-RLS table (the 057 member_pins / 060 feed pattern: all-TEXT ids, tenant_id ON DELETE CASCADE, RLS
-- ENABLE + FORCE + tenant_isolation policy + GRANT). A registered client is TENANT-BOUND: it lives under the
-- tenant resolved from the Host at registration, so a client registered against tenant A is never usable at
-- tenant B (the ADR-131 tenant-binding invariant; the authorize/token slices enforce it per request).
--
-- PUBLIC clients only: no client_secret is stored (token_endpoint_auth_method = 'none'; the OAuth flow is
-- PKCE-secured, per the metadata slice's advertisement). redirect_uris is the allowlist the authorize slice will
-- match a request's redirect_uri against EXACTLY (no substring/prefix) — the open-redirect defense lives there;
-- registration only validates each is an absolute https URI (or a loopback http URI for native clients, RFC 8252).

CREATE TABLE mcp_oauth_clients (
  id                         TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id                  TEXT NOT NULL, -- the public OAuth client_id issued at registration (random, opaque)
  redirect_uris              TEXT[] NOT NULL, -- the exact-match allowlist (>= 1, validated at registration)
  client_name                TEXT,          -- optional human label from the DCR request (display only)
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none', -- public client only (PKCE); 'none' is the sole value
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_id)
);
-- Lookup by client_id within a tenant (the authorize/token slices resolve a client here).
CREATE INDEX mcp_oauth_clients_client_idx ON mcp_oauth_clients (tenant_id, client_id);

ALTER TABLE mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_clients
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mcp_oauth_clients TO app;
