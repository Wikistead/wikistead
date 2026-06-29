import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import { encryptSecret } from '../auth/secret-crypto.js'
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

async function requireTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}

// Fetch the issuer's OIDC discovery doc (timeout-bounded) and confirm the core
// endpoints. Returns null on success, or a human error string.
export async function validateIssuer(issuer: string): Promise<string | null> {
  let url: string
  try {
    const base = issuer.endsWith('/') ? issuer : `${issuer}/`
    url = new URL('.well-known/openid-configuration', base).toString()
  } catch {
    return 'invalid issuer URL'
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return `discovery returned HTTP ${r.status}`
    const doc = (await r.json()) as { authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string }
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) return 'discovery is missing required endpoints'
    return null
  } catch {
    return 'could not reach the issuer discovery document'
  } finally {
    clearTimeout(timer)
  }
}

export async function getTenantOidc(db: TenantDb): Promise<TenantOidcView | null> {
  const [row] = await db.sql<{ issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null }[]>`
    SELECT issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim FROM tenant_oidc LIMIT 1
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
  },
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
    const err = await validateIssuer(issuer)
    if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
  }
  // Secret is write-only: a non-empty value sets it, explicit null clears it
  // (public client), undefined/'' keeps the existing one.
  const [existing] = await db.sql<{ client_secret_enc: string | null }[]>`
    SELECT client_secret_enc FROM tenant_oidc WHERE tenant_id = ${args.tenantId}
  `
  let secretEnc: string | null
  if (args.clientSecret === null) secretEnc = null
  else if (args.clientSecret) secretEnc = encryptSecret(args.clientSecret)
  else secretEnc = existing?.client_secret_enc ?? null

  await db.sql`
    INSERT INTO tenant_oidc (tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim)
    VALUES (${args.tenantId}, ${issuer}, ${clientId}, ${secretEnc}, ${scopes}, ${redirectUri}, ${args.enabled}, ${groupsClaim})
    ON CONFLICT (tenant_id) DO UPDATE SET
      issuer = ${issuer}, client_id = ${clientId}, client_secret_enc = ${secretEnc},
      scopes = ${scopes}, redirect_uri = ${redirectUri}, enabled = ${args.enabled},
      groups_claim = ${groupsClaim}, updated_at = now()
  `
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
      groupsClaim: req.body?.groupsClaim,
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
