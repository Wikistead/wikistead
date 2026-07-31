import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz' // #383
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import { encryptSecret } from '../auth/secret-crypto.js'
import { safeFetchJson } from '../safe-fetch.js'
import { otherLoginMethodsEffective, loginMethodCeiling } from '../auth/login-methods.js' // #537 lockout guard
import type { TenantDb } from '../db/index.js'

// Tenant OIDC (members' SSO) settings (Phase 5e). tenant#admin gated. Available on
// every tier (bringing your own IdP is core auth, not a paid lever). The danger is
// lockout: a broken IdP config breaks every NEW login. Mitigations:
//   - Enabling REQUIRES a passing discovery check (validateIssuer) — typo'd or
//     unreachable issuers are rejected with 400 before they can take effect.
//   - NO silent fallback: when tenant OIDC is enabled, login uses it and fails if
//     broken — it never falls back to the platform IdP (that would authenticate
//     against the wrong directory). Recovery = the admin's still-live cookie session
//     fixes/disables it. (A full break-glass code/CLI is post-launch.)
//   - The client secret is WRITE-ONLY: GET never returns it; PATCH keeps the
//     existing one unless a new value is supplied (or null to clear → public client).
export interface TenantOidcView {
  issuer: string; clientId: string; scopes: string; redirectUri: string; enabled: boolean; hasSecret: boolean
  groupsClaim: string | null // #102: id_token claim for groups (null → default 'groups')
}

// Fetch the issuer's OIDC discovery doc and confirm the core endpoints. Returns null on success, or
// a human error string. SSRF + OOM hardened (ADR-083 / #181): the issuer is admin-supplied, so the
// fetch goes through the SSRF guard (https-only, no private/metadata IP, connection pinned to the
// validated IP so DNS can't rebind to a private host), forwards no credentials, refuses redirects,
// and caps the body — never a raw fetch or an unbounded `.json()`. Self-hosted IdPs on a private
// network work only when the OPERATOR (not a tenant admin) opts in via OIDC_ALLOW_PRIVATE_ISSUER.
// The discovery fetcher is injectable ONLY so integration tests can exercise the persist / secret /
// groups flow against a local test issuer without a real TLS endpoint; production always uses the
// hardened default (safeFetchJson). The default path's https/SSRF policy is still asserted directly.
export type DiscoveryFetch = typeof safeFetchJson
export async function validateIssuer(issuer: string, fetchJson: DiscoveryFetch = safeFetchJson): Promise<string | null> {
  let url: string
  try {
    const base = issuer.endsWith('/') ? issuer : `${issuer}/`
    url = new URL('.well-known/openid-configuration', base).toString()
  } catch {
    return 'invalid issuer URL'
  }
  // Read the operator flag at call time (not module-load) so it can be set per deployment/test run.
  const allowPrivate = process.env.OIDC_ALLOW_PRIVATE_ISSUER === '1'
  try {
    const doc = (await fetchJson(url, { allowPrivate, timeoutMs: 5000, maxBytes: 256 * 1024 })) as {
      authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string
    }
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) return 'discovery is missing required endpoints'
    return null
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'scheme_blocked') return 'issuer must be an https URL'
    if (code === 'ssrf_blocked') return 'issuer address is not allowed (private/internal)'
    if (code === 'dns_unresolved') return 'could not resolve the issuer host'
    if (code === 'body_too_large') return 'discovery document is too large'
    return 'could not reach the issuer discovery document'
  }
}

export async function getTenantOidc(db: TenantDb): Promise<TenantOidcView | null> {
  const [row] = await db.sql<{ issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null }[]>`
    SELECT issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim FROM tenant_oidc ORDER BY sort, id LIMIT 1
  `
  if (!row) return null
  return {
    issuer: row.issuer, clientId: row.client_id, scopes: row.scopes,
    redirectUri: row.redirect_uri, enabled: row.enabled, hasSecret: row.client_secret_enc != null,
    groupsClaim: row.groups_claim,
  }
}

export async function updateTenantOidc(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    tenantId: string; userId: string;
    issuer: string; clientId: string; clientSecret?: string | null;
    scopes?: string; redirectUri: string; enabled: boolean; groupsClaim?: string | null;
    plan: string; // #537: the lockout guard consults SAML entitlement
  },
  fetchJson: DiscoveryFetch = safeFetchJson, // injectable for tests; prod uses the hardened default
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const issuer = args.issuer.trim()
  const clientId = args.clientId.trim()
  const redirectUri = args.redirectUri.trim()
  const scopes = (args.scopes ?? '').trim() || 'openid email profile'
  const groupsClaim = args.groupsClaim?.trim() ? args.groupsClaim.trim() : null // #102: null → default 'groups'
  if (!issuer || !clientId || !redirectUri) {
    throw Object.assign(new Error('issuer, client id and redirect URI are required'), { statusCode: 400 })
  }
  // Enabling a broken IdP would lock everyone out — validate discovery first.
  if (args.enabled) {
    const err = await validateIssuer(issuer, fetchJson)
    if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
  }
  // Secret is write-only: a non-empty value sets it, explicit null clears it
  // (public client), undefined/'' keeps the existing one.
  // #554 S1: rows carry minted uuid ids now; this legacy admin surface manages the tenant's FIRST
  // connection (ORDER BY sort, id — the same row every read path picks).
  const [existing] = await db.sql<{ id: string; client_secret_enc: string | null; enabled: boolean }[]>`
    SELECT id, client_secret_enc, enabled FROM tenant_oidc WHERE tenant_id = ${args.tenantId} ORDER BY sort, id LIMIT 1
  `
  // #537 lockout guard: disabling the tenant IdP while NOTHING else is effective (ceiling excludes
  // platform, or no platform IdP configured; SAML unentitled/disabled) would 404 every future login —
  // and unlike a broken issuer, this state looks intentional, so no discovery check catches it.
  // Refuse the TRANSITION to an empty effective set; an already-disabled row may still be edited.
  // When the ceiling itself excludes tenant-oidc the row is already outside the effective set, so
  // disabling it changes nothing — the guard steps aside (review finding C).
  if (!args.enabled && existing?.enabled && loginMethodCeiling().has('tenant-oidc') && !(await otherLoginMethodsEffective(db, { plan: args.plan }, 'tenant-oidc'))) {
    throw Object.assign(
      new Error('disabling the tenant IdP would leave this tenant with no way to sign in. Enable another login method first, or have an operator run `pnpm tenant:login-methods`.'),
      { statusCode: 409, code: 'login_lockout' },
    )
  }
  let secretEnc: string | null
  if (args.clientSecret === null) secretEnc = null
  else if (args.clientSecret) secretEnc = encryptSecret(args.clientSecret)
  else secretEnc = existing?.client_secret_enc ?? null

  // #554 S1 / ADR-197 §1: tenant_oidc is N-capable (PK = minted uuid), so the old
  // ON CONFLICT (tenant_id) upsert is gone — this surface updates ITS row by id, or mints one.
  // A fresh row minted here is the legacy tenant-IdP connection, so it keeps today's bootstrap
  // behavior: bootstrap_eligible = true (ADR-197 §2 rev2 — the flag is set only where connections
  // are created, and THIS is that surface for the tenant IdP).
  //
  // S1 review A: the old ON CONFLICT carried a DB-level single-row guarantee this read-then-write
  // lost — two concurrent first saves would mint two connections (one an orphan the legacy read
  // paths never show, but enabled and bootstrap-eligible). One transaction + an advisory lock on
  // the tenant (the bootstrapFirstAdmin discipline) restores it; the row is RE-read under the lock
  // so the loser of the race lands on the winner's row.
  await db.tx(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'tenant-oidc-save:' + args.tenantId})::bigint)`
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM tenant_oidc WHERE tenant_id = ${args.tenantId} ORDER BY sort, id LIMIT 1`
    if (row) {
      await tx`
        UPDATE tenant_oidc SET
          issuer = ${issuer}, client_id = ${clientId}, client_secret_enc = ${secretEnc},
          scopes = ${scopes}, redirect_uri = ${redirectUri}, enabled = ${args.enabled},
          groups_claim = ${groupsClaim}, updated_at = now()
        WHERE id = ${row.id}
      `
    } else {
      // #554 S6 review N1: the legacy surface's connection is TRUSTED for groups too (the same
      // grandfathering as bootstrap_eligible — this row IS "the tenant's IdP", and a silent
      // default-false here killed group sync / default roles / admin mappings for every tenant
      // configuring OIDC after migration 093, with no UI to fix it until S4).
      await tx`
        INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim, bootstrap_eligible, trust_groups)
        VALUES (${randomUUID()}, ${args.tenantId}, ${issuer}, ${clientId}, ${secretEnc}, ${scopes}, ${redirectUri}, ${args.enabled}, ${groupsClaim}, true, true)
      `
    }
  })
  emit({ type: 'tenant.oidc_updated', tenantId: args.tenantId, actorId: args.userId, enabled: args.enabled })
}

export async function tenantOidcPlugin(app: FastifyInstance) {
  app.get('/admin/oidc', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    return getTenantOidc(req.db)
  })

  app.patch<{ Body: { issuer: string; clientId: string; clientSecret?: string | null; scopes?: string; redirectUri: string; enabled: boolean; groupsClaim?: string | null } }>('/admin/oidc', async (req, reply) => {
    await updateTenantOidc(req.db, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub,
      issuer: req.body?.issuer ?? '', clientId: req.body?.clientId ?? '',
      clientSecret: req.body?.clientSecret, scopes: req.body?.scopes,
      redirectUri: req.body?.redirectUri ?? '', enabled: !!req.body?.enabled,
      groupsClaim: req.body?.groupsClaim, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  // Validate an issuer WITHOUT saving (the "Test connection" button).
  app.post<{ Body: { issuer: string } }>('/admin/oidc/test', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const error = await validateIssuer((req.body?.issuer ?? '').trim())
    return { ok: error === null, error }
  })
}
