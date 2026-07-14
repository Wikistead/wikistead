import type { TenantDb } from '../db/index.js'

// #311 / ADR-131 slice 3a: the AUTHORIZE-REQUEST VALIDATION layer for the MCP authorization server — the
// security-critical part of `/mcp/oauth/authorize` that is cleanly separable from (and lands BEFORE) the
// IdP-delegation + authorization-code minting (slice 3b, still Review-first, stop:authz). It holds NO tokens, no
// IdP redirect, no code issuance; it only RESOLVES the registered client and VALIDATES the request. Its core job
// is the open-redirect defense the DCR-register review deferred here: `redirect_uri` must EXACTLY match one the
// client registered (no substring/prefix/normalization), or nothing is redirected. Pure + DB-read only —
// unit-testable, and the slice-3b endpoint consumes it before any delegation.

export interface OAuthClient {
  clientId: string
  redirectUris: string[]
  // The DCR-supplied display name — UNTRUSTED free text (register only length-caps it). Anything rendering it
  // (the #391 consent page) MUST escape it (ADR-148: an XSS on the consent origin defeats the CSRF defense).
  clientName: string | null
}

// Resolve a registered client within the tenant (RLS). Null when unknown (the caller must then NOT redirect —
// an unknown client_id is a DIRECT error, RFC 6749 §4.1.2.1, never a redirect to an unvalidated URI).
export async function resolveClient(db: TenantDb, clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null
  const rows = await db.sql<{ client_id: string; redirect_uris: string[]; client_name: string | null }[]>`
    SELECT client_id, redirect_uris, client_name FROM mcp_oauth_clients WHERE client_id = ${clientId} LIMIT 1`
  const row = rows[0]
  return row ? { clientId: row.client_id, redirectUris: row.redirect_uris, clientName: row.client_name ?? null } : null
}

export interface AuthorizeParams {
  clientId?: string
  redirectUri?: string
  responseType?: string
  codeChallenge?: string
  codeChallengeMethod?: string
  scope?: string
  state?: string
}

export interface ValidatedAuthorizeRequest {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  state?: string
}

// An error that MUST be shown to the user directly (never redirected): an unknown client, or a redirect_uri that
// is not registered. Redirecting either would be an open redirect / a phishing vector (RFC 6749 §4.1.2.1).
export class AuthorizeDirectError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
// An error that IS returned to the (already-validated) redirect_uri as `?error=...&state=...` (RFC 6749
// §4.1.2.1) — the redirect_uri has been confirmed registered, so it is safe to bounce back to.
export class AuthorizeRedirectError extends Error {
  constructor(readonly code: string, message: string, readonly redirectUri: string, readonly state?: string) { super(message) }
}

const ALLOWED_SCOPES = new Set(['read', 'write'])

// Validate an authorize request against the resolved client. Two error classes by design (§4.1.2.1):
//   - unknown client / unregistered redirect_uri → AuthorizeDirectError (show the user; DO NOT redirect).
//   - everything else (bad response_type / missing-or-non-S256 PKCE / bad scope) → AuthorizeRedirectError
//     (the redirect_uri is confirmed, so the error goes back to it with the state).
// PKCE is REQUIRED and S256-only (matching the metadata advertisement — no `plain`, no missing challenge).
export function validateAuthorizeRequest(client: OAuthClient | null, params: AuthorizeParams): ValidatedAuthorizeRequest {
  if (!client) throw new AuthorizeDirectError('unauthorized_client', 'unknown client_id')
  const redirectUri = params.redirectUri ?? ''
  // EXACT match against the registered allowlist — no prefix, no substring, no trailing-slash normalization.
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw new AuthorizeDirectError('invalid_request', 'redirect_uri does not exactly match a registered redirect_uri')
  }
  const fail = (code: string, msg: string): never => { throw new AuthorizeRedirectError(code, msg, redirectUri, params.state) }
  if (params.responseType !== 'code') fail('unsupported_response_type', 'only response_type=code is supported')
  if (!params.codeChallenge) fail('invalid_request', 'code_challenge is required (PKCE)')
  if (params.codeChallengeMethod !== 'S256') fail('invalid_request', 'code_challenge_method must be S256')
  const scopes = (params.scope ?? 'read').trim().split(/\s+/).filter(Boolean)
  for (const s of scopes) if (!ALLOWED_SCOPES.has(s)) fail('invalid_scope', `unknown scope: ${s}`)
  return { client, redirectUri, codeChallenge: params.codeChallenge!, scopes: scopes.length ? scopes : ['read'], state: params.state }
}
