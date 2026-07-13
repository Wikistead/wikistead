import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { mintMcpAccessToken } from '@wikistead/auth'
import { consumeAuthCode } from '../auth/mcp-oauth-store.js'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from '../rate-limit.js'

const TOKEN_RL_MAX = Number(process.env.MCP_TOKEN_RL_MAX ?? 60) // token exchanges per IP per window (defense-in-depth)

// #311 / ADR-131 slice 4: the OAuth 2.1 token endpoint. Exchanges a one-time authorization code (slice 3b) +
// PKCE verifier for a TENANT-BOUND access token. Public (a public client authenticates by PKCE alone — no
// secret). This is the last piece that makes a token usable, so it MUST keep every binding the code carries or
// the slice-3b defenses reopen (review): verify PKCE, exact client_id + redirect_uri match, single-use
// code (GETDEL), and code.tenantId === the Host-resolved tenant (no cross-tenant redemption).

const MCP_TOKEN_TTL_S = Number(process.env.MCP_TOKEN_TTL_S ?? 3600)

// RFC 7636 S256: base64url(SHA256(code_verifier)) === code_challenge. The challenge is NOT secret (it was in the
// public authorize request), so a plain compare is correct; an empty verifier never matches a real challenge.
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false
  return createHash('sha256').update(codeVerifier).digest('base64url') === codeChallenge
}

interface TokenBody {
  grant_type?: string; code?: string; code_verifier?: string; client_id?: string; redirect_uri?: string
}

export async function mcpOAuthTokenPlugin(app: FastifyInstance) {
  // Public: a public client authenticates via PKCE (no secret). Tenant resolved from Host (unknown Host → 404).
  app.post<{ Body: TokenBody }>('/mcp/oauth/token', { config: { public: true } }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    // Public unauthenticated endpoint → IP rate-limit (defense-in-depth; the code is already single-use + 256-bit
    // + 60s, so this is resource-exhaustion protection, same class as the DCR endpoint).
    if (!(await bumpRateBucket(app.valkey, `rl:mcptoken:ip:${req.ip}`, TOKEN_RL_MAX, API_RATE_LIMIT_WINDOW_S))) {
      return reply.code(429).send({ error: 'too_many_requests' })
    }
    const b = (req.body ?? {}) as TokenBody
    const fail = (error: string) => reply.code(400).send({ error }) // OAuth error responses are 400 + {error}

    if (b.grant_type !== 'authorization_code') return fail('unsupported_grant_type')
    const authCode = await consumeAuthCode(app.valkey, b.code ?? '') // GETDEL → single-use (replay = null)
    if (!authCode) return fail('invalid_grant')
    // Every binding on the code MUST match (review: dropping any reopens a slice-3b defense).
    if (authCode.tenantId !== req.tenant.id) return fail('invalid_grant') // no cross-tenant redemption
    if (authCode.clientId !== b.client_id) return fail('invalid_grant')
    if (authCode.redirectUri !== b.redirect_uri) return fail('invalid_grant')
    if (!verifyPkceS256(b.code_verifier ?? '', authCode.codeChallenge)) return fail('invalid_grant') // PKCE proof

    const access_token = await mintMcpAccessToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: MCP_TOKEN_TTL_S },
      { tenantId: authCode.tenantId, sub: authCode.sub, scopes: authCode.scopes },
    )
    return { access_token, token_type: 'Bearer', expires_in: MCP_TOKEN_TTL_S, scope: authCode.scopes.join(' ') }
  })
}
