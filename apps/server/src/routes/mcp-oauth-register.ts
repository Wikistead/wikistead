import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { TenantDb } from '../db/index.js'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from '../rate-limit.js'

// #311 / ADR-131 slice 2: RFC 7591 Dynamic Client Registration for the self-hosted MCP authorization server
// (the Claude connector requires DCR; Authentik has none — ADR-131 fallback). This slice registers a
// PUBLIC client (PKCE, no secret) and does NOTHING with tokens: no authorize, no token mint, no PKCE validation
// (those are the later, Review-first slices). A registered client is inert until those land. The endpoint is
// UNAUTHENTICATED (DCR is tokenless by spec) but the tenant is resolved from the Host (config: { public: true }),
// so a client is TENANT-BOUND at birth — registered under this tenant's RLS, never usable at another tenant.
//
// Security posture of THIS slice:
//   - PUBLIC clients only: `token_endpoint_auth_method` must be 'none'; no client_secret is ever stored.
//   - redirect_uris is validated (absolute https, or an http loopback for native clients per RFC 8252) and
//     stored as the EXACT-match allowlist the authorize slice will check against (the open-redirect defense
//     lives at authorize; registration only bounds the format).
//   - Unauthenticated write → rate-limited by IP (pre-auth; the one place an IP key is right, same class as the
//     share-link token-exchange buckets, ADR-107 — consistent with ADR-138's "no IP except pre-auth" note).

const REGISTER_RL_MAX = Number(process.env.MCP_DCR_RL_MAX ?? 20) // registrations per IP per window

export interface RegisterRequest {
  redirect_uris?: unknown
  client_name?: unknown
  token_endpoint_auth_method?: unknown
}

function oauthBadRequest(error: string, description: string): Error & { statusCode: number; oauthError: string } {
  return Object.assign(new Error(description), { statusCode: 400, oauthError: error })
}

// Validate the redirect_uris allowlist (RFC 7591 §2 + RFC 8252 loopback). Each entry must be an absolute URI
// that is https, OR an http loopback (localhost / 127.0.0.1 / ::1) for a native client — never a fragment,
// never a bare/relative/other-scheme URI. Returns the cleaned list or throws a 400. Pure (unit-testable).
export function validateRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw oauthBadRequest('invalid_redirect_uri', 'redirect_uris must be a non-empty array')
  }
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw oauthBadRequest('invalid_redirect_uri', 'each redirect_uri must be a string')
    let u: URL
    try { u = new URL(raw) } catch { throw oauthBadRequest('invalid_redirect_uri', `not an absolute URI: ${raw}`) }
    const isHttps = u.protocol === 'https:'
    const host = u.hostname
    const isLoopback = u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
    if (!isHttps && !isLoopback) throw oauthBadRequest('invalid_redirect_uri', 'redirect_uri must be https or an http loopback (native client)')
    if (u.hash) throw oauthBadRequest('invalid_redirect_uri', 'redirect_uri must not contain a fragment')
    out.push(raw)
  }
  return out
}

export interface RegisteredClient {
  client_id: string
  redirect_uris: string[]
  client_name?: string
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  client_id_issued_at: number
}

// Register a new PUBLIC client under the tenant (RLS). Validates the metadata, mints an opaque client_id, and
// returns the RFC 7591 registration response. `now` is injected (ms) so the caller controls the timestamp.
export async function registerClient(db: TenantDb, tenantId: string, body: RegisterRequest, now: number): Promise<RegisteredClient> {
  const redirectUris = validateRedirectUris(body.redirect_uris)
  const authMethod = body.token_endpoint_auth_method
  if (authMethod != null && authMethod !== 'none') {
    throw oauthBadRequest('invalid_client_metadata', 'only public clients (token_endpoint_auth_method=none) are supported')
  }
  const clientId = `mcp_${randomBytes(24).toString('base64url')}`
  const clientName = typeof body.client_name === 'string' && body.client_name.trim() !== '' ? body.client_name.slice(0, 200) : null
  await db.sql`
    INSERT INTO mcp_oauth_clients (tenant_id, client_id, redirect_uris, client_name, token_endpoint_auth_method)
    VALUES (${tenantId}, ${clientId}, ${redirectUris}, ${clientName}, 'none')`
  return {
    client_id: clientId,
    redirect_uris: redirectUris,
    ...(clientName ? { client_name: clientName } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(now / 1000),
  }
}

export async function mcpOAuthRegisterPlugin(app: FastifyInstance) {
  app.post('/mcp/oauth/register', { config: { public: true } }, async (req, reply) => {
    // Pre-auth write → IP rate limit (Infinity self-host default via env would disable it; default 20/window).
    const ok = await bumpRateBucket(app.valkey, `rl:mcpdcr:ip:${req.ip}`, REGISTER_RL_MAX, API_RATE_LIMIT_WINDOW_S)
    if (!ok) return reply.code(429).send({ error: 'too_many_requests' })
    try {
      const client = await registerClient(req.db, req.tenant.id, (req.body ?? {}) as RegisterRequest, Date.now())
      return reply.code(201).send(client)
    } catch (e) {
      const err = e as { statusCode?: number; oauthError?: string; message?: string }
      if (err.statusCode === 400) return reply.code(400).send({ error: err.oauthError ?? 'invalid_client_metadata', error_description: err.message })
      throw e
    }
  })
}
