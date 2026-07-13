// #311 / ADR-131: the MCP OAuth 2.1 discovery metadata (the first, safe slice — PURE metadata, no token / DCR /
// PKCE machinery). The two documents are Host-derived so every tenant subdomain / vanity domain advertises its
// OWN tenant-bound issuer (the ADR-131 binding identity starts here). This is a fast unit test of the metadata
// builders (a fake request carrying only protocol + Host) — it pins the RFC 8414 / RFC 9728 shape and the
// per-tenant issuer without the full app. The routes' public + tenant-404 wiring rides the same well-tested
// `config: { public: true }` + Host-resolution machinery branding uses (no need to re-prove the framework).
import { describe, it, expect } from 'vitest'
import { authorizationServerMetadata, protectedResourceMetadata } from '../routes/mcp-oauth-metadata.js'

const req = (host: string, protocol = 'https') => ({ protocol, headers: { host } }) as never

describe('MCP OAuth 2.1 discovery metadata (#311 / ADR-131)', () => {
  it('RFC 8414 authorization-server metadata: Host-derived, tenant-bound issuer + endpoints', () => {
    const m = authorizationServerMetadata(req('acme.wikistead.com'))
    const base = 'https://acme.wikistead.com'
    expect(m.issuer).toBe(base) // per-tenant issuer identity (ADR-131 — the binding starts here)
    expect(m.authorization_endpoint).toBe(`${base}/mcp/oauth/authorize`)
    expect(m.token_endpoint).toBe(`${base}/mcp/oauth/token`)
    expect(m.registration_endpoint).toBe(`${base}/mcp/oauth/register`) // RFC 7591 DCR advertised (Claude connector)
    // PKCE S256 REQUIRED (no `plain`); public clients only (DCR + PKCE, no secret); read/write scopes (ADR-131 §3).
    expect(m.code_challenge_methods_supported).toEqual(['S256'])
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(m.response_types_supported).toEqual(['code'])
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(m.scopes_supported).toEqual(['read', 'write'])
  })

  it('RFC 9728 protected-resource metadata: the /mcp resource points at THIS tenant as its own AS', () => {
    const m = protectedResourceMetadata(req('acme.wikistead.com'))
    const base = 'https://acme.wikistead.com'
    expect(m.resource).toBe(`${base}/mcp`)
    expect(m.authorization_servers).toEqual([base]) // resource + AS are co-tenant (same origin)
    expect(m.scopes_supported).toEqual(['read', 'write'])
    expect(m.bearer_methods_supported).toEqual(['header'])
  })

  it('a DIFFERENT tenant Host yields a DIFFERENT issuer (per-tenant binding, not a shared AS)', () => {
    expect(authorizationServerMetadata(req('team-a.wikistead.com')).issuer).toBe('https://team-a.wikistead.com')
    expect(authorizationServerMetadata(req('team-b.example.org')).issuer).toBe('https://team-b.example.org') // vanity domain
  })

  it('the full origin (host:port + protocol) flows into the issuer verbatim', () => {
    // protocol honours trustProxy (x-forwarded-proto) at runtime; the builder just echoes protocol + Host.
    expect(authorizationServerMetadata(req('dev.localhost:8443', 'http')).issuer).toBe('http://dev.localhost:8443')
  })
})
