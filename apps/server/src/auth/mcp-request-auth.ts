import type { FastifyRequest } from 'fastify'
import { verifyMcpAccessToken } from '@wikistead/auth'

// #311 / ADR-131 slice 5: authenticate an /mcp request from its Bearer access token (minted by slice 4). This is
// the (a)+(b) binding the token-endpoint review requires at the tool surface: verify the `mcp+jwt` signature/typ,
// AND bind it to the Host-resolved tenant — a token minted for tenant A is REJECTED at tenant B (the one genuine
// new attack surface, ADR-131). The token asserts IDENTITY only; the tool handler re-checks OpenFGA on
// `user:<sub>` per operation (the ADR-075 broker rule) and enforces the token's scopes as a ceiling.

export interface McpPrincipal { sub: string; tenantId: string; scopes: string[]; groups: string[] }

export async function authenticateMcpRequest(req: FastifyRequest, hostTenantId: string): Promise<McpPrincipal> {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  if (!m) throw Object.assign(new Error('missing bearer token'), { statusCode: 401 })
  let claims
  try {
    // ttlSeconds is unused on verify (exp is read from the token itself); only the secret matters.
    claims = await verifyMcpAccessToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 0 }, m[1]!)
  } catch {
    throw Object.assign(new Error('invalid or expired token'), { statusCode: 401 })
  }
  // Tenant binding (the new attack surface): the token's tenant MUST equal the Host-resolved tenant.
  if (claims.tenantId !== hostTenantId) throw Object.assign(new Error('token tenant mismatch'), { statusCode: 401 })
  return {
    sub: claims.sub, tenantId: claims.tenantId,
    scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
    groups: Array.isArray(claims.groups) ? claims.groups : [],
  }
}
