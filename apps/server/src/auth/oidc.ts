// Thin wrapper over openid-client v6 (functional API). The library owns the
// security-critical mechanics — discovery, PKCE, state/nonce generation and
// verification, code exchange, id_token signature/iss/aud/exp validation — which
// we deliberately do NOT hand-roll.
import * as oidc from 'openid-client'
import { guardedFetch } from '../safe-fetch.js'

// clientSecret is the DECRYPTED value (loaders decrypt tenant_oidc; the platform
// config reads it from env in plaintext). null = public/PKCE client.
export interface TenantOidcConfig {
  issuer: string
  clientId: string
  clientSecret: string | null
  scopes: string
  redirectUri: string
  // ADR-055 / #102: which id_token claim holds the user's groups. Default 'groups' (Authentik/
  // Keycloak/Okta); per-tenant override for IdPs that use 'roles' or a custom claim.
  groupsClaim?: string
}

// ADR-055 / #102: coerce an UNTRUSTED groups claim (it rides the token) into a safe string[].
// Accept only an array of non-empty strings; trim, de-dupe, and BOUND it (≤100 groups, ≤200 chars
// each) so a hostile/huge token can't blow up the row or the FGA writes. Over-limit is truncated +
// logged, NEVER thrown — an IdP anomaly must not block login (the owner approval condition).
const MAX_GROUPS = 100
const MAX_GROUP_LEN = 200
export function coerceGroups(raw: unknown, sub?: string): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  let dropped = false
  for (const v of raw) {
    if (typeof v !== 'string') { dropped = true; continue }
    const name = v.trim()
    if (!name) { dropped = true; continue }
    const bounded = name.length > MAX_GROUP_LEN ? name.slice(0, MAX_GROUP_LEN) : name
    if (bounded.length < name.length) dropped = true
    if (!seen.has(bounded)) seen.add(bounded)
    if (seen.size >= MAX_GROUPS) { dropped = dropped || seen.size < raw.length; break }
  }
  if (dropped || seen.size < raw.length) {
    console.warn(`[oidc:groups] coerced groups claim for ${sub ?? 'user'}: ${raw.length} in → ${seen.size} kept (truncated/filtered)`)
  }
  return [...seen]
}

// The platform IdP (Cloud only) from env — the DEFAULT identity source for tenants
// without their own IdP, AND the identity check for Cloud signup. Unset on CE.
export function loadPlatformOidc(): TenantOidcConfig | null {
  const issuer = process.env.PLATFORM_OIDC_ISSUER
  if (!issuer) return null
  return {
    issuer,
    clientId: process.env.PLATFORM_OIDC_CLIENT_ID!,
    clientSecret: process.env.PLATFORM_OIDC_CLIENT_SECRET ?? null,
    scopes: process.env.PLATFORM_OIDC_SCOPES ?? 'openid email profile',
    redirectUri: process.env.PLATFORM_OIDC_REDIRECT_URI!,
    groupsClaim: process.env.PLATFORM_OIDC_GROUPS_CLAIM, // #102: default 'groups' if unset
  }
}

// SSRF hardening (ADR-083 / #181 review): openid-client makes THREE issuer-derived fetches — discovery,
// JWKS (id_token signature keys), token endpoint — and `customFetch` is assigned to the Configuration so
// ALL of them go through one guard. `guardedFetch` re-validates each URL (https-only, every resolved IP
// public unless the operator opted in) and pins the socket to the validated IP. This closes the hole the
// discovery-only fix left: a legit public discovery doc could aim `jwks_uri`/`token_endpoint` at an
// internal address, and the unguarded key/token fetch would reach it. The `OIDC_ALLOW_PRIVATE_ISSUER`
// operator flag now governs discovery AND jwks AND token uniformly (self-hosted private IdP key fetch
// works only under the same opt-in). Read at call time (per deployment/test), not module load.
//
// http:// issuers are local/test ONLY — a tenant admin CANNOT save one (validateIssuer / safeFetchJson
// is https-only, so an enabled tenant issuer is always https). The only http issuers are the operator's
// env-configured PLATFORM IdP or tests, so that path keeps openid-client's default fetch + the explicit
// allowInsecureRequests opt-in; it is not attacker-reachable and needs no IP guard.
async function discover(cfg: TenantOidcConfig): Promise<oidc.Configuration> {
  if (cfg.issuer.startsWith('http://')) {
    return oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret ?? undefined, undefined, { execute: [oidc.allowInsecureRequests] })
  }
  const allowPrivate = process.env.OIDC_ALLOW_PRIVATE_ISSUER === '1'
  return oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret ?? undefined, undefined, {
    [oidc.customFetch]: guardedFetch({ allowPrivate }) as unknown as oidc.CustomFetch,
  })
}

export interface LoginRedirect {
  url: string
  state: string
  nonce: string
  codeVerifier: string
}

// Build the IdP authorization URL with a fresh state/nonce/PKCE verifier. The
// redirect_uri is passed in (derived from the request: scheme+host+callback path)
// rather than read from cfg, because it varies by tenant subdomain and by flow
// (/auth/callback vs /signup/callback). The caller persists {state → nonce,
// codeVerifier, ...} (consume-once) before redirecting. NOTE: a production IdP must
// have these redirect_uris registered (wildcard subdomain or a central callback) —
// an ops concern (P7).
export async function buildLogin(cfg: TenantOidcConfig, redirectUri: string, extraParams?: Record<string, string>): Promise<LoginRedirect> {
  const config = await discover(cfg)
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const url = oidc.buildAuthorizationUrl(config, {
    // #281 / ADR-121 §2: vendor extras FIRST so they can never override the security
    // params below (state/nonce/PKCE always win). Used for the social source hint.
    ...(extraParams ?? {}),
    redirect_uri: redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).href
  return { url, state, nonce, codeVerifier }
}

// #281 / ADR-121 §2: the Cloud social-login button config, from env. CSV of provider slugs
// (e.g. "google,github,microsoft") — empty/unset (and always on CE, which has no platform
// issuer) means NO social buttons. The hint param name is deployment-configurable because
// the broker (Authentik) decides what it consumes; the value is the provider slug.
export interface SocialLoginConfig { providers: string[]; hintParam: string }
const SOCIAL_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
export function loadSocialLogin(): SocialLoginConfig {
  if (!process.env.PLATFORM_OIDC_ISSUER) return { providers: [], hintParam: 'source' } // CE: no platform IdP → no social
  const providers = (process.env.PLATFORM_SOCIAL_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SOCIAL_SLUG.test(s))
  return { providers, hintParam: process.env.PLATFORM_SOCIAL_HINT_PARAM ?? 'source' }
}

// #281 / ADR-121 §3.5: coerce the UNTRUSTED `email_verified` claim to a strict tri-state.
// Only boolean true / string "true" count as verified (some IdPs stringify booleans);
// false / "false" is explicitly unverified; anything else (missing, junk) is null =
// UNKNOWN — and the domain auto-enroll branch requires exactly `true`, so unknown
// fails safe to the invite path (user ruling: never block login, only the auto-enroll).
export function coerceEmailVerified(raw: unknown): boolean | null {
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  return null
}

export interface IdpClaims {
  sub: string
  email: string | null
  // #281 / ADR-121 §3.5: whether the IdP asserts the email is verified (tri-state; see
  // coerceEmailVerified). Load-bearing for domain auto-enroll — never discard it.
  emailVerified: boolean | null
  name: string | null
  // `picture` is the standard OIDC profile-image URL claim. Peer-visible identity
  // (avatar / collab cursor) — never email. NULL when the IdP omits it.
  picture: string | null
  // ADR-055 / #102: the user's groups from the configured claim, coerced + bounded. Fed to the
  // existing establishMemberSession path (#111: members.groups + FGA group#member sync). [] when
  // the IdP omits it. Applies only to already-provisioned members (login never creates membership).
  groups: string[]
}

// Exchange the callback code for tokens and return the verified id_token claims.
// Throws if state/nonce/PKCE/signature checks fail (openid-client enforces them).
export async function exchangeCode(
  cfg: TenantOidcConfig,
  currentUrl: string,
  expect: { state: string; nonce: string; codeVerifier: string },
): Promise<IdpClaims> {
  const config = await discover(cfg)
  const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
    expectedState: expect.state,
    expectedNonce: expect.nonce,
    pkceCodeVerifier: expect.codeVerifier,
  })
  const claims = tokens.claims()
  if (!claims?.sub) throw new Error('id_token has no sub')
  const sub = String(claims.sub)
  return {
    sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: coerceEmailVerified((claims as Record<string, unknown>).email_verified),
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
    // #102: read the configured groups claim (default 'groups'); coerce/bound the untrusted value.
    groups: coerceGroups((claims as Record<string, unknown>)[cfg.groupsClaim || 'groups'], sub),
  }
}
