// Thin wrapper over openid-client v6 (functional API). The library owns the
// security-critical mechanics — discovery, PKCE, state/nonce generation and
// verification, code exchange, id_token signature/iss/aud/exp validation — which
// we deliberately do NOT hand-roll.
import * as oidc from 'openid-client'

// clientSecret is the DECRYPTED value (loaders decrypt tenant_oidc; the platform
// config reads it from env in plaintext). null = public/PKCE client.
export interface TenantOidcConfig {
  issuer: string
  clientId: string
  clientSecret: string | null
  scopes: string
  redirectUri: string
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
  }
}

// allowInsecureRequests is enabled ONLY for http issuers (local/test). Production
// issuers are https and get the default (TLS-required) behavior.
async function discover(cfg: TenantOidcConfig): Promise<oidc.Configuration> {
  const options = cfg.issuer.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : undefined
  return oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret ?? undefined, undefined, options)
}

export interface LoginRedirect {
  url: string
  state: string
  nonce: string
  codeVerifier: string
}

// Build the IdP authorization URL with a fresh state/nonce/PKCE verifier. The
// caller persists {state → nonce, codeVerifier, ...} (consume-once) before redirect.
export async function buildLogin(cfg: TenantOidcConfig): Promise<LoginRedirect> {
  const config = await discover(cfg)
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).href
  return { url, state, nonce, codeVerifier }
}

export interface IdpClaims {
  sub: string
  email: string | null
  name: string | null
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
  return {
    sub: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
  }
}
