import type { FastifyRequest } from 'fastify'
import { verifyMcpAccessToken } from '@wikistead/auth'
import { fgaClient, isTenantMember } from '@wikistead/authz'

// #311 / ADR-131 slice 5: authenticate an /mcp request from its Bearer access token (minted by slice 4). This is
// the (a)+(b) binding the token-endpoint review requires at the tool surface: verify the `mcp+jwt` signature/typ,
// AND bind it to the Host-resolved tenant — a token minted for tenant A is REJECTED at tenant B (the one genuine
// new attack surface, ADR-131). The token asserts IDENTITY only; the tool handler re-checks OpenFGA on
// `user:<sub>` per operation (the ADR-075 broker rule) and enforces the token's scopes as a ceiling.

export interface McpPrincipal { sub: string; tenantId: string; scopes: string[]; groups: string[] }

/** FGA stores `user:<id>` in 512 bytes; `user:` costs 5, so a complete subject may be 507. */
const MAX_MCP_SUB_LENGTH = 507

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
  // #471 / ADR-176: /mcp opts out of the shared member hook (`config: { public: true }`) and runs this
  // instead, so the tenant binding has to be repeated here — including membership, resolved per
  // request. Without it a removed member's token kept working until it expired, which for an MCP
  // access token is long after the tenant believes the account is gone.
  // #592 / ADR-204: this seam asks WHO ASSERTED the subject, not what it looks like.
  //
  // It used to run the EXTERNAL gate (`externalSubViolation`) here, which refuses any reserved prefix.
  // But since #570 every connection created through the admin surface stamps `wc<conn8>_` on the subs
  // it mints, so that check was refusing OUR OWN members: a namespaced member could complete the whole
  // OAuth dance and then be 401'd by every tool call. The prefix is not evidence of an intruder here;
  // it is evidence of exactly the opposite.
  //
  // INVARIANT this relies on: *the sub in an mcp+jwt was read from a session*. `mintMcpAccessToken` is
  // called in one place, with `authCode.sub`, which came from `req.user.sub` on a session-authenticated
  // route (mcp-oauth-flow.ts). If a future seam mints an MCP-like token from a CLAIM instead, this
  // reasoning is void — break it out loud, not by editing this line quietly.
  //
  // The shared validator is deliberately NOT relaxed: it guards ten seams, and the external ones must
  // keep refusing. What stays here is the part that is about the value rather than its provenance —
  // a malformed sub, and the length FGA can actually store. The ruler is 507 (FGA's 512-byte
  // `user:<id>` budget minus `user:`) rather than the external 496, because at this seam the subject is
  // already complete: a namespaced member whose raw sub is 486-496 bytes is legitimate and fits.
  if (claims.sub.length === 0 || /\s/.test(claims.sub) || Buffer.byteLength(claims.sub, 'utf8') > MAX_MCP_SUB_LENGTH) {
    throw Object.assign(new Error('invalid or expired token'), { statusCode: 401 })
  }
  if (!(await isTenantMember(fgaClient, claims.sub, hostTenantId))) {
    throw Object.assign(new Error('invalid or expired token'), { statusCode: 401 })
  }
  // #592 / ADR-204 (OQ3): a connection may withhold MCP from its members, and the server is the wall —
  // a member of a disabled connection is refused here even holding a valid, correctly minted token
  // (#537's rule: what the UI hides, the server refuses). The connection is identified by the subject
  // prefix, the only in-band signal a member's sub carries; a sub without one predates namespacing and
  // has no connection to consult, so it keeps today's access.
  const prefix = /^wc[0-9a-f]{8}_/.exec(claims.sub)?.[0]
  if (prefix) {
    const [conn] = await req.db.sql<{ mcp_enabled: boolean }[]>`
      SELECT mcp_enabled FROM tenant_oidc WHERE subject_prefix = ${prefix} LIMIT 1`
    if (conn && !conn.mcp_enabled) throw Object.assign(new Error('invalid or expired token'), { statusCode: 401 })
  }
  return {
    sub: claims.sub, tenantId: claims.tenantId,
    scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
    groups: Array.isArray(claims.groups) ? claims.groups : [],
  }
}
