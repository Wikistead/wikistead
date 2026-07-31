import { randomBytes } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz' // #383
import type { FastifyInstance } from 'fastify'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { entitlementDenied } from '../entitlement-ux.js'
import { pool } from '../db/pool.js'
import { withTenantTx, type TenantDb } from '../db/index.js'
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

  // last_ok_at is the liveness sweep's grace anchor (#576): a manual verification IS a success, and
  // leaving it behind would hand the next sweep a stale anchor from the previous ownership period.
  await db.sql`UPDATE custom_domains SET status = 'verified', verified_at = now(), last_ok_at = now(), check_failures = 0
               WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
  // Activate host→tenant resolution (ADR-016). tenants is the global registry (no tenant RLS);
  // billing updates it via the raw pool too. UNIQUE(custom_domain) guards cross-tenant collision.
  await pool`UPDATE tenants SET custom_domain = ${domain} WHERE id = ${args.tenantId}`
  emit({ type: 'tenant.custom_domain_verified', tenantId: args.tenantId, domain })
  return { verified: true }
}

// #576: the RE-verification sweep. A domain proved ours once; nothing asked again, so a domain that
// stopped being ours (DNS moved, the dev tunnel died, the registration lapsed) kept winning
// `tenantBaseUrl` and every notification mail carried a link to a dead host — silently, because the
// only signal was a user clicking it.
//
// The shape (the ticket's option 1, with the abuse guard it asked for): re-run the SAME DNS-TXT
// ownership primitive the manual verify uses — one primitive, no looser second path — and demote
// only after DEMOTE_AFTER consecutive failures AND a grace window since the last success. A single
// resolver hiccup, or an outage shorter than the window, must never unpick a customer's domain.
// Demotion is verified→pending, the reversible direction: the row, its token and the admin's
// configuration survive, `tenants.custom_domain` is cleared so host→tenant resolution and
// tenantBaseUrl fall back to the platform URL, and pressing Verify again restores it.
//
// HONEST LIMIT: this proves OWNERSHIP, not reachability. A domain whose TXT record still stands but
// whose server answers nothing keeps its verified status — catching that needs an HTTP probe, which
// is a different (and SSRF-shaped) decision. Stated so nobody reads this as a health check.
// #576 re-review, the two defects that made v1 production-fatal, and what replaced them:
//
//  1. It took an `sql` handle and every caller passed one — the acceptance test passed the SUPERUSER
//     admin connection, so the fixture went green while the same code under the runtime pool saw
//     ZERO rows: custom_domains is RLS'd on app.tenant_id and the sweep sets no tenant. A
//     namespace-promoted tenant was invisible for a second reason (its rows live in its own schema,
//     and public.* still holds the frozen rollback copy — the #382 trap withTenantTx exists for).
//     So the handle is no longer an argument: the sweep enumerates `tenants` (no RLS, the drift
//     worker's precedent) and reads each tenant's rows inside its own withTenantTx. There is no
//     signature left for a test to pass an admin connection through.
//  2. The grace anchor advanced on every tick, so "24h since the last success" was re-zeroed by the
//     check that saw the failure and never elapsed. Migration 096 splits the two meanings:
//     last_checked_at = when we last looked, last_ok_at = when it was last proved ours.
//
// Also: the writes are now conditional (`AND status = 'verified'`) and the counter increments in SQL
// rather than from a value read a network round-trip earlier, so two overlapping sweeps — or a
// replica running the same worker — cannot demote twice or resurrect a counter.
export const DEMOTE_AFTER = 3
export const GRACE_MS = 24 * 60 * 60 * 1000

type DomainRow = { domain: string; verification_token: string; check_failures: number; verified_at: Date | null; last_ok_at: Date | null }

export async function recheckCustomDomains(
  opts: { resolveTxt?: ResolveTxt; now?: Date; demoteAfter?: number; graceMs?: number } = {},
): Promise<{ checked: number; demoted: string[] }> {
  const now = opts.now ?? new Date()
  const demoteAfter = opts.demoteAfter ?? DEMOTE_AFTER
  const graceMs = opts.graceMs ?? GRACE_MS
  // EVERY tenant, not just the ones `tenants.custom_domain` still points at: tenantBaseUrl decides
  // from the custom_domains row's status, so a verified row whose mapping drifted to NULL is exactly
  // the state that must still be re-checked. custom_domains is RLS'd, so this cannot be one join.
  const tenants = await pool<{ id: string }[]>`SELECT id FROM tenants`
  const demoted: string[] = []
  let checked = 0
  for (const tenant of tenants) {
    // Per tenant, like the drift sweep: one tenant whose rows are unreadable (DB hiccup, tenant
    // vanished between the registry read and now) must not cost every other tenant its check.
    try {
      const rows = await withTenantTx(tenant.id, async (tx) => tx<DomainRow[]>`
        SELECT domain, verification_token, check_failures, verified_at, last_ok_at
        FROM custom_domains WHERE status = 'verified'`)
      for (const row of rows) {
        checked++
        let present: boolean
        try {
          present = await txtChallengePresent(row.domain, row.verification_token, opts.resolveTxt)
        } catch {
          present = false // an unreachable resolver counts as one failure, never as proof of loss
        }
        if (present) {
          await withTenantTx(tenant.id, (tx) => tx`
            UPDATE custom_domains SET check_failures = 0, last_checked_at = ${now}, last_ok_at = ${now}
            WHERE domain = ${row.domain} AND status = 'verified'`)
          continue
        }
        // The anchor is the last time we KNOW it was ours; before any sweep has succeeded that is
        // the manual verification itself.
        const lastGood = row.last_ok_at ?? row.verified_at ?? now
        const pastGrace = now.getTime() - new Date(lastGood).getTime() >= graceMs
        const willDemote = row.check_failures + 1 >= demoteAfter && pastGrace
        const affected = await withTenantTx(tenant.id, async (tx) => {
          const res = willDemote
            ? await tx`UPDATE custom_domains SET status = 'pending', check_failures = check_failures + 1, last_checked_at = ${now}
                       WHERE domain = ${row.domain} AND status = 'verified'`
            : await tx`UPDATE custom_domains SET check_failures = check_failures + 1, last_checked_at = ${now}
                       WHERE domain = ${row.domain} AND status = 'verified'`
          // Same transaction as the demotion: the registry mapping and the row's status are one fact
          // (host→tenant resolution reads the mapping, tenantBaseUrl reads the row), and a crash
          // between them leaves a live host pointing at a domain the product calls unverified.
          if (willDemote && res.count > 0) {
            await tx`UPDATE tenants SET custom_domain = NULL WHERE id = ${tenant.id} AND custom_domain = ${row.domain}`
          }
          return res.count
        })
        if (willDemote && affected > 0) {
          // A customer's domain stopping being theirs is an operator-visible event, not a silent
          // state change: v1 emitted nothing a log search could find.
          console.warn('[custom-domains] demoted verified→pending after sustained DNS failure', {
            tenantId: tenant.id, domain: row.domain, failures: row.check_failures + 1, lastOkAt: lastGood,
          })
          emit({ type: 'tenant.custom_domain_unverified', tenantId: tenant.id, domain: row.domain })
          demoted.push(row.domain)
        }
      }
    } catch (err) {
      console.error('[custom-domains] tenant skipped; next sweep retries', { tenantId: tenant.id, err })
    }
  }
  return { checked, demoted }
}

// The periodic driver (the startAdminDriftWorker precedent: interval, self-scheduling, cancellable,
// and NOT re-entrant — a sweep slower than the interval, e.g. a resolver timing out per domain,
// would otherwise stack ticks and have two passes counting the same failure).
export function startCustomDomainRecheckWorker(intervalMs = 6 * 60 * 60 * 1000): () => void {
  let running = false
  const t = setInterval(async () => {
    if (running) return
    running = true
    try {
      await recheckCustomDomains()
    } catch {
      /* a sweep that fails retries next tick */
    } finally {
      running = false
    }
  }, intervalMs)
  t.unref?.()
  return () => clearInterval(t)
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
