import { randomBytes } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz' // #383
import type { FastifyInstance } from 'fastify'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { entitlementDenied } from '../entitlement-ux.js'
import { pool } from '../db/pool.js'
import type { TenantDb } from '../db/index.js'
import { CHALLENGE_PREFIX, txtChallengePresent, type ResolveTxt } from '../auth/dns-challenge.js'

// Custom-domain verification registry (#123 / ADR-065). A Pro tenant brings its own domain;
// we issue a TLS cert ONLY after DNS ownership is verified (issuing for arbitrary caller hosts
// is an abuse/impersonation vector). This module owns the app-side workflow: add → DNS TXT
// challenge → verify → activate (mirror to tenants.custom_domain, which host→tenant resolution
// already reads, ADR-016) → revoke. The cert-manager `Certificate` lifecycle is infra (#148);
// a Certificate is only ever created for a `verified` row.

// Basic hostname validation: lowercased FQDN, no scheme/path/port, ≤253 chars.
function normalizeDomain(raw: string): string {
  const d = (raw ?? '').trim().toLowerCase()
  if (!/^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/.test(d)) {
    throw Object.assign(new Error('invalid domain'), { statusCode: 400, code: 'invalid_domain' })
  }
  return d
}

export interface CustomDomainView {
  domain: string; status: string; verifiedAt: Date | null
  // What the tenant must publish in DNS to prove ownership (shown until verified).
  challengeRecord: string; challengeValue: string
}

function toView(row: { domain: string; verification_token: string; status: string; verified_at: Date | null }): CustomDomainView {
  return {
    domain: row.domain, status: row.status, verifiedAt: row.verified_at,
    challengeRecord: `${CHALLENGE_PREFIX}.${row.domain}`, challengeValue: row.verification_token,
  }
}

export async function listCustomDomains(db: TenantDb): Promise<CustomDomainView[]> {
  const rows = await db.sql<{ domain: string; verification_token: string; status: string; verified_at: Date | null }[]>`
    SELECT domain, verification_token, status, verified_at FROM custom_domains ORDER BY created_at
  `
  return rows.map(toView)
}

// Add a custom domain (pending). Entitlement-gated (customDomain); a domain already claimed by
// any tenant is rejected (UNIQUE(domain) → 409) so it can't be taken from another tenant.
export async function addCustomDomain(
  db: TenantDb,
  args: { tenantId: string; plan: string; domain: string },
): Promise<CustomDomainView> {
  if (!resolveEntitlements(args.plan).customDomain) {
    throw entitlementDenied('custom_domain', 'custom domains are not available on this plan')
  }
  const domain = normalizeDomain(args.domain)
  const token = randomBytes(24).toString('base64url')
  try {
    const [row] = await db.sql<{ domain: string; verification_token: string; status: string; verified_at: Date | null }[]>`
      INSERT INTO custom_domains (tenant_id, domain, verification_token)
      VALUES (${args.tenantId}, ${domain}, ${token})
      RETURNING domain, verification_token, status, verified_at
    `
    emit({ type: 'tenant.custom_domain_added', tenantId: args.tenantId, domain })
    return toView(row)
  } catch (e) {
    if ((e as { code?: string }).code === '23505') { // unique_violation
      throw Object.assign(new Error('domain already in use'), { statusCode: 409, code: 'domain_taken' })
    }
    throw e
  }
}

// Verify ownership by looking up the DNS TXT challenge. On success the domain is activated:
// status=verified AND mirrored to tenants.custom_domain (host→tenant resolution reads that, so
// ONLY a verified domain ever resolves). `resolveTxt` is injectable for tests.
export async function verifyCustomDomain(
  db: TenantDb,
  args: { tenantId: string; domain: string },
  opts: { resolveTxt?: ResolveTxt } = {},
): Promise<{ verified: boolean }> {
  const domain = normalizeDomain(args.domain)
  const [row] = await db.sql<{ verification_token: string; status: string }[]>`
    SELECT verification_token, status FROM custom_domains WHERE domain = ${domain}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  // Same DNS-TXT ownership check as enrol domains (#101) — one primitive, no looser second path.
  if (!(await txtChallengePresent(domain, row.verification_token, opts.resolveTxt))) {
    throw Object.assign(new Error('DNS challenge not found yet'), { statusCode: 400, code: 'not_verified' })
  }

  await db.sql`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
  // Activate host→tenant resolution (ADR-016). tenants is the global registry (no tenant RLS);
  // billing updates it via the raw pool too. UNIQUE(custom_domain) guards cross-tenant collision.
  await pool`UPDATE tenants SET custom_domain = ${domain} WHERE id = ${args.tenantId}`
  emit({ type: 'tenant.custom_domain_verified', tenantId: args.tenantId, domain })
  return { verified: true }
}

// Remove a custom domain — three-point revocation (ADR-065): drop the registry row, clear the
// host→tenant mapping (tenants.custom_domain), and (infra) the cert-manager Certificate is
// deleted out of band. Used on explicit release AND on entitlement loss (ADR-064 downgrade).
export async function removeCustomDomain(db: TenantDb, args: { tenantId: string; domain: string }): Promise<void> {
  const domain = normalizeDomain(args.domain)
  await db.sql`DELETE FROM custom_domains WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
  // Clear the resolution mapping only if it points at THIS domain (don't clobber another).
  await pool`UPDATE tenants SET custom_domain = NULL WHERE id = ${args.tenantId} AND custom_domain = ${domain}`
  emit({ type: 'tenant.custom_domain_removed', tenantId: args.tenantId, domain })
}

export async function customDomainsPlugin(app: FastifyInstance) {
  app.get('/admin/custom-domains', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    return listCustomDomains(req.db)
  })

  app.post<{ Body: { domain?: string } }>('/admin/custom-domains', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const view = await addCustomDomain(req.db, { tenantId: req.tenant.id, plan: req.tenant.plan, domain: req.body?.domain ?? '' })
    return reply.code(201).send(view)
  })

  app.post<{ Params: { domain: string } }>('/admin/custom-domains/:domain/verify', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await verifyCustomDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
    return reply.code(204).send()
  })

  app.delete<{ Params: { domain: string } }>('/admin/custom-domains/:domain', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await removeCustomDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
    return reply.code(204).send()
  })
}
