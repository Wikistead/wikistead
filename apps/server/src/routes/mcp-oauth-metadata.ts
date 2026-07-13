import type { FastifyInstance, FastifyRequest } from 'fastify'

// #311 / ADR-131: the OAuth 2.1 authorization-server + protected-resource DISCOVERY metadata for the MCP
// connector. This is the FIRST, deliberately safe slice of the self-hosted authorization server (ADR-131
// fallback — Authentik has no DCR, so Wikistead fronts /mcp with a thin OAuth 2.1 AS): it is PURE METADATA and
// holds NONE of the security-critical machinery. No token is minted, no PKCE is validated, no DCR client is
// stored, no authz decision is made here — those are separate slices (each landing with review code
// backing per the ADR-131 stop:authz discipline). Advertising an endpoint that does not exist yet is inert and
// safe: an MCP client that fetches this metadata and then calls /mcp/oauth/register gets a plain 404 (a graceful
// failure, never a security surface), exactly like the landed-inert page#parent prep tuples (#218).
//
// Both documents are PUBLIC (`config: { public: true }`): OAuth discovery MUST be fetchable without a token, but
// the tenant is still resolved from the Host (an unknown host → the standard 404), so metadata is never served
// for a non-existent tenant. The issuer / resource are derived from the request Host (the SAME
// `${protocol}://${host}` convention the OIDC login uses, auth.ts) so every tenant subdomain / vanity domain
// advertises its OWN tenant-bound issuer — the ADR-131 invariant that a token is bound to one tenant starts
// here (the issuer identity is per-tenant), even though the binding is enforced by the later token slice.

// The tenant-bound base URL for this request (protocol honours trustProxy → x-forwarded-proto). The issuer is
// the origin; the AS/DCR endpoints live under /mcp/oauth and the protected resource is the /mcp transport URL.
function baseUrl(req: Pick<FastifyRequest, 'protocol' | 'headers'>): string {
  return `${req.protocol}://${req.headers.host}`
}

// RFC 8414 — OAuth 2.0 Authorization Server Metadata. PKCE S256 is REQUIRED (no `plain`); public clients only
// (`token_endpoint_auth_methods_supported: ["none"]` — DCR-registered public client + PKCE, no client secret);
// scopes are the ADR-131 §3 read / write tiers. `registration_endpoint` advertises RFC 7591 DCR (the Claude
// connector requirement that forced the self-hosted AS).
export function authorizationServerMetadata(req: Pick<FastifyRequest, 'protocol' | 'headers'>) {
  const base = baseUrl(req)
  return {
    issuer: base,
    authorization_endpoint: `${base}/mcp/oauth/authorize`,
    token_endpoint: `${base}/mcp/oauth/token`,
    registration_endpoint: `${base}/mcp/oauth/register`,
    response_types_supported: ['code'],
    // Only authorization_code is supported today; refresh_token is a later slice, so it is NOT advertised (a
    // client that saw it would loop on a failing refresh after token expiry — the connector re-runs authorize).
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'write'],
  }
}

// RFC 9728 — OAuth 2.0 Protected Resource Metadata. The protected resource is the /mcp transport; its
// authorization server is THIS tenant's issuer (same origin) — the resource and the AS are co-tenant, so a token
// from another tenant's AS is not advertised as valid here (the binding is enforced later, at the token slice).
export function protectedResourceMetadata(req: Pick<FastifyRequest, 'protocol' | 'headers'>) {
  const base = baseUrl(req)
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
  }
}

export async function mcpOAuthMetadataPlugin(app: FastifyInstance) {
  // Public discovery docs (no auth; tenant resolved from Host → 404 for an unknown tenant). Cached briefly:
  // metadata is static per host, but stays short so an endpoint-layout change (later slices) propagates.
  app.get('/.well-known/oauth-authorization-server', { config: { public: true } }, async (req, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return authorizationServerMetadata(req)
  })

  app.get('/.well-known/oauth-protected-resource', { config: { public: true } }, async (req, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return protectedResourceMetadata(req)
  })
}
