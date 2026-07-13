// #311 / ADR-131 slice 3b: the short-lived, consume-once Valkey stores for the MCP OAuth authorization-code
// flow. Two stores, both GETDEL (atomic fetch-and-delete — a replayed pending-request or auth code both fail),
// mirroring the OIDC login-state pattern (oidc-state.ts). NO tokens live here (slice 4 mints the access token);
// this holds only (a) the validated authorize request across the IdP login round-trip and (b) the one-time
// authorization code bound to the member sub + client + redirect_uri + PKCE challenge.
import type IORedis from 'ioredis'

const PENDING_TTL_S = 600 // authorize → post-login complete window
const CODE_TTL_S = 60 // code issuance → token exchange window (short, single-use)

const pendingKey = (id: string) => `mcpauthz:pending:${id}`
const codeKey = (code: string) => `mcpauthz:code:${code}`

// The validated authorize request, stashed at /mcp/oauth/authorize and consumed at /mcp/oauth/complete after the
// member logs in. redirect_uri is ALREADY validated (exact-match registered) when stored, so /complete redirects
// to it without re-deriving from tamperable request params. tenantId binds it to the tenant it was started under.
export interface PendingAuthorize {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  state?: string
  tenantId: string
  // Flow-binding nonce (login-CSRF / auth-code-injection defense): mirrored into an httpOnly cookie set at
  // /authorize, and REQUIRED to match at /complete — so the browser that COMPLETES the flow (and whose logged-in
  // sub the code is bound to) is the SAME browser that STARTED it. Without this, an attacker could start a flow
  // with their own client + code_challenge, then trick a logged-in victim into hitting /complete → a code bound
  // to the VICTIM'S sub sent to the ATTACKER'S redirect_uri (account takeover at slice 4). See ADR-131.
  flowNonce: string
}

// The one-time authorization code, minted at /complete (after login) and consumed at /token (slice 4). Bound to
// the member sub + tenant + client + redirect_uri + PKCE challenge so the token exchange can verify all of them.
export interface AuthCode {
  sub: string
  tenantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  groups: string[] // the member's groups at consent time (carried into the token for group-granted tool access)
}

export async function savePendingAuthorize(valkey: IORedis, id: string, data: PendingAuthorize): Promise<void> {
  await valkey.set(pendingKey(id), JSON.stringify(data), 'EX', PENDING_TTL_S)
}
export async function consumePendingAuthorize(valkey: IORedis, id: string): Promise<PendingAuthorize | null> {
  if (!id) return null
  const raw = await valkey.getdel(pendingKey(id))
  if (!raw) return null
  try { return JSON.parse(raw) as PendingAuthorize } catch { return null }
}

export async function saveAuthCode(valkey: IORedis, code: string, data: AuthCode): Promise<void> {
  await valkey.set(codeKey(code), JSON.stringify(data), 'EX', CODE_TTL_S)
}
export async function consumeAuthCode(valkey: IORedis, code: string): Promise<AuthCode | null> {
  if (!code) return null
  const raw = await valkey.getdel(codeKey(code))
  if (!raw) return null
  try { return JSON.parse(raw) as AuthCode } catch { return null }
}

// Append query params to an ALREADY-VALIDATED redirect_uri (exact-match registered, https/loopback). Uses the URL
// API so existing query params are preserved and values are encoded. Never called on an unvalidated URI.
export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v)
  return u.toString()
}
