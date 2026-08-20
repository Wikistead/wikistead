import { randomBytes } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz' // #383
import type { FastifyInstance } from 'fastify'
import type { TenantDb } from '../db/index.js'
import { CHALLENGE_PREFIX, txtChallengePresent, type ResolveTxt } from './dns-challenge.js'
import { ENROLL_POLICIES, isEnrollPolicy, type EnrollPolicy } from './enroll-policy.js'

// #101 / ADR-034 (addendum): the enrol-domain allow-list + its DNS-TXT verification, and the assembled
// enrol config a login path reads. A domain is honoured for the `domain` policy ONLY once ownership is
// proven via the SAME challenge as custom domains (#123) — `verified_at` is set exclusively here.

// Basic hostname validation (mirror of custom-domains normalizeDomain): lowercased FQDN, ≤253 chars.
function normalizeDomain(raw: string): string {
  const d = (raw ?? '').trim().toLowerCase()
  if (!/^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/.test(d)) {
    throw Object.assign(new Error('invalid domain'), { statusCode: 400, code: 'invalid_domain' })
  }
  return d
}

export interface EnrollDomainView {
  domain: string; verified: boolean; verifiedAt: Date | null
  challengeRecord: string; challengeValue: string // what to publish in DNS until verified
}
function toView(row: { domain: string; verification_token: string; verified_at: Date | null }): EnrollDomainView {
  return {
    domain: row.domain, verified: row.verified_at != null, verifiedAt: row.verified_at,
    challengeRecord: `${CHALLENGE_PREFIX}.${row.domain}`, challengeValue: row.verification_token,
  }
}

export async function listEnrollDomains(db: TenantDb): Promise<EnrollDomainView[]> {
  const rows = await db.sql<{ domain: string; verification_token: string; verified_at: Date | null }[]>`
    SELECT domain, verification_token, verified_at FROM enroll_domains ORDER BY created_at
  `
  return rows.map(toView)
}

// Add a pending enrol-domain with a fresh challenge token. Pending (verified_at NULL) is inert for enrol.
export async function addEnrollDomain(db: TenantDb, args: { tenantId: string; domain: string }): Promise<EnrollDomainView> {
  const domain = normalizeDomain(args.domain)
  const token = randomBytes(24).toString('base64url')
  const [row] = await db.sql<{ domain: string; verification_token: string; verified_at: Date | null }[]>`
    INSERT INTO enroll_domains (tenant_id, domain, verification_token)
    VALUES (${args.tenantId}, ${domain}, ${token})
    ON CONFLICT (tenant_id, domain) DO UPDATE SET verification_token = EXCLUDED.verification_token
    RETURNING domain, verification_token, verified_at
  `
  return toView(row!)
}

// Prove ownership via the DNS-TXT challenge (SAME primitive as custom domains). ONLY this sets
// verified_at — there is no other write path to it (the reviewer's rule: no other path may set verified).
export async function verifyEnrollDomain(
  db: TenantDb,
  args: { tenantId: string; domain: string },
  opts: { resolveTxt?: ResolveTxt } = {},
): Promise<{ verified: boolean }> {
  const domain = normalizeDomain(args.domain)
  const [row] = await db.sql<{ verification_token: string }[]>`
    SELECT verification_token FROM enroll_domains WHERE domain = ${domain}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (!(await txtChallengePresent(domain, row.verification_token, opts.resolveTxt))) {
    throw Object.assign(new Error('DNS challenge not found yet'), { statusCode: 400, code: 'not_verified' })
  }
  await db.sql`UPDATE enroll_domains SET verified_at = now() WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
  return { verified: true }
}

export async function removeEnrollDomain(db: TenantDb, args: { tenantId: string; domain: string }): Promise<void> {
  const domain = normalizeDomain(args.domain)
  await db.sql`DELETE FROM enroll_domains WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
}

export interface EnrollConfig {
  policy: EnrollPolicy
  verifiedDomains: string[] // ONLY DNS-verified domains — feeds enrollEligible's trust boundary
  allowedGroups: string[]
}

// Assemble the enrol config a login path passes to enrollEligible (auth/enroll-policy). The domain trust
// boundary is enforced HERE: `verifiedDomains` is exactly the enrol_domains whose verified_at is set — a
// pending (un-proven) domain is never included, so it can't admit an enrol.
export async function getEnrollConfig(db: TenantDb): Promise<EnrollConfig> {
  const [settings] = await db.sql<{ enroll_policy: string; enroll_allowed_groups: string[] }[]>`
    SELECT enroll_policy, enroll_allowed_groups FROM tenant_settings LIMIT 1
  `
  const policy = isEnrollPolicy(settings?.enroll_policy) ? settings.enroll_policy : 'invite_only'
  const verified = await db.sql<{ domain: string }[]>`
    SELECT domain FROM enroll_domains WHERE verified_at IS NOT NULL
  `
  return {
    policy,
    verifiedDomains: verified.map((r) => r.domain),
    allowedGroups: settings?.enroll_allowed_groups ?? [],
  }
}

// Set the tenant's enrol policy + groups allow-list (upsert the settings row). Validates the policy is
// one of the 4 values — an unknown value is rejected, never stored (getEnrollConfig also fails safe).
export async function setEnrollPolicy(db: TenantDb, args: { tenantId: string; policy: string; allowedGroups?: string[] }): Promise<void> {
  if (!isEnrollPolicy(args.policy)) throw Object.assign(new Error('invalid enroll policy'), { statusCode: 400, code: 'invalid_policy' })
  const groups = (args.allowedGroups ?? []).map((g) => g.trim()).filter(Boolean)
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, enroll_policy, enroll_allowed_groups)
    VALUES (${args.tenantId}, ${args.policy}, ${db.sql.array(groups)})
    ON CONFLICT (tenant_id) DO UPDATE SET enroll_policy = EXCLUDED.enroll_policy, enroll_allowed_groups = EXCLUDED.enroll_allowed_groups, updated_at = now()
  `
}

// Admin routes for enrolment configuration (tenant-admin gated). The login-path ENFORCEMENT
// (session.ts auto-enrol via enrollEligible + the seat fortress) is a later slice — these manage the
// config it reads. Mirrors the custom-domains admin workflow (add → DNS TXT challenge → verify).
export async function enrollmentPlugin(app: FastifyInstance) {
  app.get('/admin/enrollment', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const cfg = await getEnrollConfig(req.db)
    return { ...cfg, policies: ENROLL_POLICIES, domains: await listEnrollDomains(req.db) }
  })
  app.put<{ Body: { policy?: string; allowedGroups?: string[] } }>('/admin/enrollment', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await setEnrollPolicy(req.db, { tenantId: req.tenant.id, policy: req.body?.policy ?? '', allowedGroups: req.body?.allowedGroups })
    return reply.code(204).send()
  })
  app.post<{ Body: { domain?: string } }>('/admin/enrollment/domains', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    return reply.code(201).send(await addEnrollDomain(req.db, { tenantId: req.tenant.id, domain: req.body?.domain ?? '' }))
  })
  app.post<{ Params: { domain: string } }>('/admin/enrollment/domains/:domain/verify', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await verifyEnrollDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
    return reply.code(204).send()
  })
  app.delete<{ Params: { domain: string } }>('/admin/enrollment/domains/:domain', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await removeEnrollDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
    return reply.code(204).send()
  })
}
