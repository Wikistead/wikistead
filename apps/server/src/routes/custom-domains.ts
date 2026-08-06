import { randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import { requireTenantAdmin, runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz' // #383
import type { FastifyInstance } from 'fastify'
import { resolveEntitlements } from '@wikistead/entitlements'
import { passkeysStrandedBy } from '../auth/passkeys.js'
import { secondFactorStance } from '../auth/factor-policy.js' // #680 / ADR-222 §2
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
  /**
   * #664: how many members would lose a passkey if this domain became the one serving the tenant.
   *
   * ZERO means the warning is not shown. A caution about something that cannot happen is one nobody
   * reads the next time it appears, and this screen has to be believed on the day it matters.
   */
  passkeysStranded?: number
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
  // #664 / ADR-219 §1 (ruling 4): a passkey is bound to an RP ID, so moving the tenant to its own
  // domain invalidates every one made under the old host. The ruling requires the warning to appear in
  // the FLOW, before it commits — not in a release note — so the count travels with the row that the
  // "verify" button sits on.
  //
  // Counted per DOMAIN rather than once, because each pending domain is a different destination and the
  // answer differs: a domain already serving this tenant strands nobody.
  const views = rows.map(toView)
  return Promise.all(views.map(async (v) => ({ ...v, passkeysStranded: await passkeysStrandedBy(db, v.domain) })))
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
  // ONE transaction (db.tx, not the session handle — #576 re-review 2: the claim was "same tx" and the
  // session handle is not one): the row's status and the registry mapping are a single fact, and a
  // crash between them leaves a live host pointing at a domain the product calls unverified.
  // Activate host→tenant resolution (ADR-016). tenants is the global registry (no tenant RLS).
  // The just-verified row is the newest, so syncDomainMapping names it — going through the one
  // expression keeps this path from being the odd one out when a tenant holds several domains.
  await db.tx(async (tx) => {
    await tx`UPDATE custom_domains SET status = 'verified', verified_at = now(), last_ok_at = now(),
                    check_failures = 0, auto_demoted_at = NULL
             WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
    await syncDomainMapping(tx, args.tenantId)
  })
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
//     CAVEAT, not fixed here: a namespace schema is a LIKE copy taken at promotion, and later
//     migrations only touch public — so a tenant promoted before 095/096/097 has no such columns and
//     its SELECT raises 42703. That is a repo-wide gap in how namespace tenants are migrated, not
//     something this sweep can close; here it surfaces as a logged per-tenant error rather than a
//     silent "nothing to check".
//  2. The grace anchor advanced on every tick, so "24h since the last success" was re-zeroed by the
//     check that saw the failure and never elapsed. Migration 096 splits the two meanings:
//     last_checked_at = when we last looked, last_ok_at = when it was last proved ours.
//
// Also: the writes are now conditional (`AND status = 'verified'`) and the counter increments in SQL
// rather than from a value read a network round-trip earlier, so two overlapping sweeps — or a
// replica running the same worker — cannot demote twice or resurrect a counter.
export const DEMOTE_AFTER = 3
export const GRACE_MS = 24 * 60 * 60 * 1000

type DomainRow = {
  domain: string; verification_token: string; check_failures: number
  verified_at: Date | null; last_ok_at: Date | null; status: string; auto_demoted_at: Date | null
}

// #576 re-review 2: two readers disagreed about which domain is live. `tenantBaseUrl` picks the
// newest VERIFIED custom_domains row (email/base-url.ts); host→tenant resolution reads
// `tenants.custom_domain` (db/registry.ts). One tenant with two verified domains was enough to
// split them: demoting the mapped one cleared the mapping, the OTHER row then won tenantBaseUrl,
// and nothing resolved that host — the sweep manufacturing the exact symptom (#576) it exists to
// prevent, and worse than the bug, because the fallback to the platform URL never happened.
//
// So the mapping is no longer patched by hand at each site. This states, in the one place, the same
// expression tenantBaseUrl uses: the mapping IS the newest verified row, or NULL when there is
// none. Every path that changes a row's status calls it inside the same transaction, which also
// repairs a mapping that drifted for any other reason.
async function syncDomainMapping(tx: Sql, tenantId: string): Promise<void> {
  // `AND tenant_id` as well as RLS: this ticket has now twice been bitten by a handle that was not
  // tenant-scoped, and a mapping derived from another tenant's row would be the worst possible way to
  // find out a third time.
  const [live] = await tx<{ domain: string }[]>`
    SELECT domain FROM custom_domains WHERE tenant_id = ${tenantId} AND status = 'verified'
    ORDER BY verified_at DESC LIMIT 1`
  await tx`UPDATE tenants SET custom_domain = ${live?.domain ?? null} WHERE id = ${tenantId}`
}

export async function recheckCustomDomains(
  opts: { resolveTxt?: ResolveTxt; now?: Date; demoteAfter?: number; graceMs?: number } = {},
): Promise<{ checked: number; demoted: string[]; restored: string[] }> {
  const now = opts.now ?? new Date()
  const demoteAfter = opts.demoteAfter ?? DEMOTE_AFTER
  const graceMs = opts.graceMs ?? GRACE_MS
  // EVERY tenant, not just the ones `tenants.custom_domain` still points at: tenantBaseUrl decides
  // from the custom_domains row's status, so a verified row whose mapping drifted to NULL is exactly
  // the state that must still be re-checked. custom_domains is RLS'd, so this cannot be one join.
  const tenants = await pool<{ id: string }[]>`SELECT id FROM tenants`
  const demoted: string[] = []
  const restored: string[] = []
  let checked = 0
  for (const tenant of tenants) {
    // Per tenant, like the drift sweep: one tenant whose rows are unreadable (DB hiccup, tenant
    // vanished between the registry read and now) must not cost every other tenant its check.
    try {
      // Verified rows, plus the pending ones THIS sweep demoted. The second half is the way back:
      // a demotion caused by our own resolver being down for a day would otherwise be permanent,
      // repairable only through an endpoint with no UI behind it (migration 097 says why it is
      // limited to the sweep's own demotions and never completes a human's enrolment).
      const rows = await withTenantTx(tenant.id, async (tx) => tx<DomainRow[]>`
        SELECT domain, verification_token, check_failures, verified_at, last_ok_at, status, auto_demoted_at
        FROM custom_domains
        WHERE status = 'verified' OR (status = 'pending' AND auto_demoted_at IS NOT NULL)
        ORDER BY domain`)
      for (const row of rows) {
        checked++
        let present: boolean
        try {
          present = await txtChallengePresent(row.domain, row.verification_token, opts.resolveTxt)
        } catch {
          present = false // an unreachable resolver counts as one failure, never as proof of loss
        }

        if (row.status !== 'verified') {
          if (!present) continue // still gone: leave it pending, no counting against a pending row
          const back = await withTenantTx(tenant.id, async (tx) => {
            const res = await tx`
              UPDATE custom_domains SET status = 'verified', verified_at = ${now}, last_ok_at = ${now},
                     last_checked_at = ${now}, check_failures = 0, auto_demoted_at = NULL
              WHERE domain = ${row.domain} AND status = 'pending' AND auto_demoted_at IS NOT NULL`
            if (res.count > 0) await syncDomainMapping(tx, tenant.id)
            return res.count
          })
          if (back > 0) {
            console.warn('[custom-domains] restored pending→verified: the domain proved ours again', { tenantId: tenant.id, domain: row.domain })
            emit({ type: 'tenant.custom_domain_verified', tenantId: tenant.id, domain: row.domain })
            restored.push(row.domain)
          }
          continue
        }

        if (present) {
          await withTenantTx(tenant.id, async (tx) => {
            await tx`UPDATE custom_domains SET check_failures = 0, last_checked_at = ${now}, last_ok_at = ${now}
                     WHERE domain = ${row.domain} AND status = 'verified'`
            await syncDomainMapping(tx, tenant.id) // also repairs a mapping that drifted
          })
          continue
        }
        // The anchor is the last time we KNOW it was ours; before any sweep has succeeded that is
        // the manual verification itself.
        const lastGood = row.last_ok_at ?? row.verified_at ?? now
        const pastGrace = now.getTime() - new Date(lastGood).getTime() >= graceMs
        const willDemote = row.check_failures + 1 >= demoteAfter && pastGrace
        const affected = await withTenantTx(tenant.id, async (tx) => {
          // Compare-and-set on the counter, not just on the status: an admin who fixes their DNS and
          // presses Verify lands on `status = 'verified', check_failures = 0` — status alone would
          // let a sweep that read the row a probe earlier demote them a moment after they succeeded.
          // The two events correlate (both happen when the outage ends), so this is not theoretical.
          const res = willDemote
            ? await tx`UPDATE custom_domains SET status = 'pending', check_failures = check_failures + 1,
                              last_checked_at = ${now}, auto_demoted_at = ${now}
                       WHERE domain = ${row.domain} AND status = 'verified' AND check_failures = ${row.check_failures}`
            : await tx`UPDATE custom_domains SET check_failures = check_failures + 1, last_checked_at = ${now}
                       WHERE domain = ${row.domain} AND status = 'verified' AND check_failures = ${row.check_failures}`
          // Same transaction as the demotion: the registry mapping and the row's status are one fact
          // (host→tenant resolution reads the mapping, tenantBaseUrl reads the row), and a crash
          // between them leaves a live host pointing at a domain the product calls unverified.
          if (willDemote && res.count > 0) await syncDomainMapping(tx, tenant.id)
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
      // Includes the case where this tenant's schema predates a custom_domains migration (a
      // namespace-promoted tenant is a LIKE copy and later migrations only touch public) — it fails
      // loudly here rather than being read as "nothing to check".
      console.error('[custom-domains] tenant skipped; next sweep retries', { tenantId: tenant.id, err })
    }
  }
  return { checked, demoted, restored }
}

// The periodic driver (the startAdminDriftWorker precedent: interval, self-scheduling, cancellable,
// and NOT re-entrant — a sweep slower than the interval, e.g. a resolver timing out per domain,
// would otherwise stack ticks and have two passes counting the same failure).
export const DEFAULT_RECHECK_MS = 6 * 60 * 60 * 1000

// #576 re-review 3: `Number(process.env.X ?? default)` is not a parser. `??` only catches undefined, so
// an env line left EMPTY (`CUSTOM_DOMAIN_RECHECK_MS=`) reads as 0 and switched the sweep off in silence
// — this ticket exists because a worker was silently doing nothing in production, and that would have
// been the same bug wearing a different hat. `6h` reads as NaN, which is not <= 0, so it reached
// setInterval(NaN) — a hot loop. Only a finite number counts; anything else falls back and says so.
export function recheckIntervalFromEnv(raw: string | undefined, fallback = DEFAULT_RECHECK_MS): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.warn('[custom-domains] CUSTOM_DOMAIN_RECHECK_MS is not a number; using the default', { raw, fallback })
    return fallback
  }
  return n
}

export function startCustomDomainRecheckWorker(intervalMs = DEFAULT_RECHECK_MS): () => void {
  // A non-positive interval switches the sweep OFF — deliberately, and never quietly. It exists for one
  // honest reason: the dev seed shortcuts the DNS-TXT challenge to make host routing work locally
  // (infra/db/seed.ts), so the seeded domain cannot prove ownership and the sweep would correctly demote
  // it a day later and take local host routing with it. A dev pointing a real tunnel at a real TXT
  // record needs no such switch, and a production operator who sees this line knows what it costs.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.warn('[custom-domains] liveness re-verification DISABLED — a custom domain that stops being the tenant\'s will keep deciding link hosts', { intervalMs })
    return () => {}
  }
  let running = false
  const t = setInterval(async () => {
    if (running) return
    running = true
    try {
      // #637 / ADR-216 §2: not on behalf of a request, and it SAYS so. An explicit unrestricted scope,
      // rather than arriving with none — which in a process that declared the requirement is a crash, and
      // in one that has not is indistinguishable from a request path where somebody forgot.
      await runInAuthzScope(SYSTEM_SCOPE, () => recheckCustomDomains())
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
  // #576 re-review 2: this was the ONE status-changing path still clearing the mapping by hand, and it
  // reproduced the exact split it was supposed to be fixed by — deleting the mapped domain of a tenant
  // that holds two verified ones cleared tenants.custom_domain while the OTHER row went on winning
  // tenantBaseUrl, so links pointed at a host nothing resolved until the next sweep repaired it
  // (measured by the reviewer, up to a 6h window of dead links). Same derivation as everywhere else.
  await db.tx(async (tx) => {
    await tx`DELETE FROM custom_domains WHERE tenant_id = ${args.tenantId} AND domain = ${domain}`
    await syncDomainMapping(tx, args.tenantId)
  })
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

  app.post<{ Params: { domain: string }; Body: { acknowledgePasskeyLoss?: boolean } }>(
    '/admin/custom-domains/:domain/verify',
    async (req, reply) => {
      await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
      // #664 / ADR-219 §1 (ruling 4): verification is the step that makes this domain the one serving
      // the tenant, and a passkey is bound to the RP ID it was made under — so this is the moment every
      // enrolled key stops working.
      //
      // REFUSED rather than merely reported. There is no console for custom domains yet (this surface
      // is API-only while #235 is blocked), so a field in the list response is a warning that can be
      // skipped by not reading it, and the ruling asks for one that appears BEFORE it commits. The
      // acknowledgement is the same shape #605 uses: a refusal with a reason and a named way through,
      // which a future screen turns into a checkbox rather than into a surprise.
      // #680 / ADR-222 §2: under a `passkey` stance the acknowledgement is not enough, because what it
      // acknowledges is not what happens. Its own sentence — "they will each have to enrol again" — is
      // untrue here: the keys stop working, and the door then refuses the only kind anybody could
      // present, so nobody signs in TO enrol again. That is the whole tenant locked out, recoverable
      // only through the operator break-glass, which a Cloud tenant does not have.
      //
      // Refused rather than warned, and the sentence names the way through: widen the stance first,
      // move, and narrow it again once everybody has a key on the new host.
      if ((await secondFactorStance(req.db)) === 'passkey') {
        return reply.code(409).send({
          error: 'this workspace requires passkeys, and every passkey stops working when the domain changes — nobody would be able to sign in, including to enrol a new one. Set "a passkey or an authenticator app" first, move, then require passkeys again.',
          code: 'passkey_stance_blocks_move',
        })
      }
      const stranded = await passkeysStrandedBy(req.db, req.params.domain)
      if (stranded > 0 && req.body?.acknowledgePasskeyLoss !== true) {
        return reply.code(409).send({
          error: `${stranded} member${stranded === 1 ? '' : 's'} would lose every passkey: a passkey only works on the host it was created for, and they will each have to enrol again. Confirm to continue.`,
          code: 'passkeys_would_be_lost',
          passkeysStranded: stranded,
        })
      }
      await verifyCustomDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
      return reply.code(204).send()
    },
  )

  app.delete<{ Params: { domain: string } }>('/admin/custom-domains/:domain', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    await removeCustomDomain(req.db, { tenantId: req.tenant.id, domain: req.params.domain })
    return reply.code(204).send()
  })
}
