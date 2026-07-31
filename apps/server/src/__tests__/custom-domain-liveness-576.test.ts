// #576: a domain proved ours once and was never asked again, so a domain that stopped being ours
// kept winning tenantBaseUrl and every notification mail carried a link to a dead host. The sweep
// re-runs the SAME DNS-TXT ownership primitive the manual verify uses and demotes verified→pending
// — but only after consecutive failures AND a grace window, because a resolver hiccup must never
// unpick a customer's domain.
//
// #576 re-review — what the first version of this file proved, and why it proved nothing:
//  - it passed the SUPERUSER admin connection into the sweep. The sweep sets no app.tenant_id, so
//    under the runtime pool RLS answers zero rows and the worker was a no-op in production while
//    this file was green. The sweep now takes NO handle, so there is nothing to substitute: every
//    read and write below goes through the same pool the server uses (`pool` is imported only to
//    close it in afterAll).
//  - it drove ONE tick per case. The grace anchor advanced on every tick, so at the production
//    interval the window could never elapse — invisible to a single-tick test. Every timing case
//    here now runs the production interval over simulated days and binds BOTH directions: it
//    demotes after the window, and it does NOT demote before it.
// A separate `admin` connection remains, for fixture setup/inspection only — never for the sweep.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { recheckCustomDomains, removeCustomDomain, verifyCustomDomain, DEMOTE_AFTER, GRACE_MS } from '../routes/custom-domains.js'
import { tenantBaseUrl } from '../email/base-url.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `cd576-${STAMP}`
const DOMAIN = `wiki-${STAMP}.example.test`
const asTenant = (id: string): Tenant => ({ id, slug: SLUG, plan: 'business', isolation: 'logical' }) as Tenant

const INTERVAL_MS = 6 * 60 * 60 * 1000 // the production worker's tick

let tenantId = ''
let db: TenantDb
let token = ''

// the TXT resolver, switchable per case: "the record is there" vs "the domain is gone"
const present = (): ((d: string) => Promise<string[][]>) => async () => [[token]] // the record holds the TOKEN; CHALLENGE_PREFIX is the record NAME
const gone = (): ((d: string) => Promise<string[][]>) => async () => { throw new Error('ENOTFOUND') }

// Run the sweep the way the worker does — a fixed interval, from a starting instant — and report
// when (if ever) the domain was demoted. `t0` is "now" at the first tick.
async function runTicks(days: number, resolveTxt: ReturnType<typeof gone>, t0 = Date.now()): Promise<{ ticks: number; demotedAtTick: number | null }> {
  const ticks = Math.round((days * 24 * 60 * 60 * 1000) / INTERVAL_MS)
  for (let i = 1; i <= ticks; i++) {
    const r = await recheckCustomDomains({ resolveTxt, now: new Date(t0 + i * INTERVAL_MS) })
    if (r.demoted.includes(DOMAIN)) return { ticks, demotedAtTick: i }
  }
  return { ticks, demotedAtTick: null }
}

const row = async () =>
  (await admin<{ status: string; check_failures: number; last_ok_at: Date | null }[]>`
    SELECT status, check_failures, last_ok_at FROM custom_domains WHERE domain = ${DOMAIN}`)[0]
const mapped = async () =>
  (await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`)[0]?.custom_domain

beforeAll(async () => {
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: `cd576-admin-${STAMP}` } })
  tenantId = t.tenantId
  db = await acquireTenantDb(asTenant(tenantId))
  token = 'tok' + STAMP
  await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at, last_ok_at)
    VALUES (${tenantId}, ${DOMAIN}, ${token}, 'verified', now(), now())`
  await admin`UPDATE tenants SET custom_domain = ${DOMAIN} WHERE id = ${tenantId}`
}, 60_000)

afterEach(async () => {
  await admin`UPDATE custom_domains SET status = 'verified', check_failures = 0, last_checked_at = NULL, verified_at = now(), last_ok_at = now() WHERE domain = ${DOMAIN}`
  await admin`UPDATE tenants SET custom_domain = ${DOMAIN} WHERE id = ${tenantId}`
})

afterAll(async () => {
  await db.release()
  // the tenant this fixture provisioned goes away whole — rows AND the registry entry, so the next
  // sweep in any other suite does not walk a half-deleted tenant (#576 re-review: v1 left it behind)
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end(); await pool.end()
}, 60_000)

describe('#576: a custom domain that stopped being ours stops deciding link hosts', () => {
  it('the sweep sees the tenant through the RUNTIME pool (no admin handle exists to pass)', async () => {
    // The regression pin for defect 1: recheckCustomDomains takes no sql argument, so this call is
    // the production path — RLS-enforced app role, per-tenant transaction. If the sweep ever goes
    // back to a tenant-less cross-tenant read, `checked` is 0 here and every case below is vacuous.
    const r = await recheckCustomDomains({ resolveTxt: present() })
    expect(r.checked, 'the RLS-scoped read found this tenant\'s verified domain').toBeGreaterThanOrEqual(1)
    expect(r.demoted).not.toContain(DOMAIN)
  }, 60_000)

  it('a live domain survives, resets its failure counter and moves the grace anchor', async () => {
    await admin`UPDATE custom_domains SET check_failures = 2, last_ok_at = now() - interval '10 days' WHERE domain = ${DOMAIN}`
    const before = (await row())!.last_ok_at!
    await recheckCustomDomains({ resolveTxt: present() })
    const after = (await row())!
    expect(after).toMatchObject({ status: 'verified', check_failures: 0 })
    expect(new Date(after.last_ok_at!).getTime(), 'a success is what moves the anchor').toBeGreaterThan(new Date(before).getTime())
  }, 60_000)

  it('30 days of production ticks demote exactly once, and only after the grace window', async () => {
    // Defect 2's regression pin. With the anchor advancing on every tick this loop demoted NEVER
    // (measured: 120 ticks, 0 demotions). It must now demote — and not before the window elapses.
    const t0 = Date.now()
    const { ticks, demotedAtTick } = await runTicks(30, gone(), t0)
    expect(ticks, 'the real interval, not one hand-driven call').toBe(120)
    expect(demotedAtTick, 'a domain gone for a month does get demoted').not.toBeNull()

    // and it is the LATER of the two conditions that decides: failures reach the threshold at tick
    // DEMOTE_AFTER, the window elapses at GRACE_MS/interval, and the demotion waits for both.
    const graceTicks = Math.ceil(GRACE_MS / INTERVAL_MS)
    expect(demotedAtTick).toBe(Math.max(DEMOTE_AFTER, graceTicks))
    expect((await row())!.status).toBe('pending')
  }, 120_000)

  it('an outage SHORTER than the grace window never demotes, however many ticks it spans', async () => {
    // the abuse guard, in the shape that matters: a resolver down for most of a day
    const t0 = Date.now()
    const { ticks, demotedAtTick } = await runTicks(0.75, gone(), t0) // 18h = 3 ticks ≥ DEMOTE_AFTER
    expect(ticks, 'long enough to pass the failure threshold').toBeGreaterThanOrEqual(DEMOTE_AFTER)
    expect(demotedAtTick, 'the window has not elapsed — the customer keeps their domain').toBeNull()
    expect((await row())!).toMatchObject({ status: 'verified' })
    expect(await mapped()).toBe(DOMAIN)
  }, 120_000)

  it('a recovery inside the window re-arms the whole guard (the anchor moves, the count resets)', async () => {
    const t0 = Date.now()
    await runTicks(0.75, gone(), t0) // three failures, no demotion yet
    await recheckCustomDomains({ resolveTxt: present(), now: new Date(t0 + 4 * INTERVAL_MS) })
    expect((await row())!.check_failures, 'one success wipes the streak').toBe(0)
    // …and the clock restarts from there: another 18h of failure still must not demote
    const later = await runTicks(0.75, gone(), t0 + 4 * INTERVAL_MS)
    expect(later.demotedAtTick).toBeNull()
  }, 120_000)

  it('a sustained failure demotes reversibly, and the canonical URL falls back to the platform', async () => {
    process.env.WKS_PUBLIC_BASE_URL = 'https://wikistead.example.com'
    try {
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG }), 'before: the custom domain wins').toBe(`https://${DOMAIN}`)

      const { demotedAtTick } = await runTicks(3, gone())
      expect(demotedAtTick).not.toBeNull()

      const after = (await row())!
      expect(after.status, 'demoted, not deleted — the admin keeps their configuration').toBe('pending')
      expect((await admin<{ verification_token: string }[]>`SELECT verification_token FROM custom_domains WHERE domain = ${DOMAIN}`)[0]!.verification_token,
        'the token survives, so Verify works without re-adding').toBe(token)
      expect(await mapped(), 'host→tenant resolution stops pointing at the dead name').toBeNull()
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG }), 'links fall back instead of pointing at a dead host').toBe(`https://${SLUG}.wikistead.example.com`)

      // and the reverse direction works: proving ownership again restores everything
      await verifyCustomDomain(db, { tenantId, domain: DOMAIN }, { resolveTxt: present() })
      const restored = (await row())!
      expect(restored.status).toBe('verified')
      expect(restored.check_failures, 'a manual verify re-arms the guard too').toBe(0)
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG })).toBe(`https://${DOMAIN}`)
    } finally {
      delete process.env.WKS_PUBLIC_BASE_URL
    }
  }, 120_000)

  // #576 re-review 2. The reviewer found the fix manufacturing the ticket's own symptom: with TWO
  // verified domains, demoting the mapped one cleared tenants.custom_domain while the other row
  // still won tenantBaseUrl — links built on a host that resolved to nothing, and no fallback to
  // the platform URL either. The two readers must agree by construction.
  describe('a tenant with two domains: the URL builder and host→tenant resolution never disagree', () => {
    const SECOND = `alt-${STAMP}.example.test`
    const secondToken = `tok2${STAMP}`
    // resolveTxt is per-domain here: the OLD domain stays live, the mapped one disappears
    const onlySecondGone = (): ((d: string) => Promise<string[][]>) => async (d: string) => {
      if (d.includes(SECOND)) throw new Error('ENOTFOUND')
      return [[token]]
    }
    beforeAll(async () => {
      // DOMAIN verified first (older), SECOND verified after it — so SECOND is what both readers pick
      await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at, last_ok_at)
        VALUES (${tenantId}, ${SECOND}, ${secondToken}, 'verified', now() + interval '1 minute', now())`
      await admin`UPDATE tenants SET custom_domain = ${SECOND} WHERE id = ${tenantId}`
    })
    afterAll(async () => { await admin`DELETE FROM custom_domains WHERE domain = ${SECOND}`.catch(() => {}) })
    afterEach(async () => {
      await admin`UPDATE custom_domains SET status = 'verified', check_failures = 0, auto_demoted_at = NULL, last_ok_at = now() WHERE domain = ${SECOND}`
      await admin`UPDATE tenants SET custom_domain = ${SECOND} WHERE id = ${tenantId}`
    })

    it('demoting the mapped domain hands the mapping to the OTHER verified one, not to NULL', async () => {
      process.env.WKS_PUBLIC_BASE_URL = 'https://wikistead.example.com'
      try {
        const t0 = Date.now()
        let hit: string[] = []
        for (let i = 1; i <= 8 && !hit.includes(SECOND); i++) {
          hit = (await recheckCustomDomains({ resolveTxt: onlySecondGone(), now: new Date(t0 + i * INTERVAL_MS) })).demoted
        }
        expect(hit, 'the dead one is demoted').toContain(SECOND)
        expect(await mapped(), 'the mapping follows to the surviving verified domain').toBe(DOMAIN)
        expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG }), 'and it is the SAME domain the URL builder picks')
          .toBe(`https://${DOMAIN}`)
      } finally {
        delete process.env.WKS_PUBLIC_BASE_URL
      }
    }, 120_000)

    it('REMOVING the mapped domain hands the mapping to the survivor too (the delete path)', async () => {
      // #576 re-review 2, reproduced by the reviewer: removeCustomDomain was the one status-changing
      // path still clearing the mapping by hand, so deleting the mapped domain left the OTHER verified
      // row winning tenantBaseUrl with nothing resolving it — dead links until the next sweep.
      process.env.WKS_PUBLIC_BASE_URL = 'https://wikistead.example.com'
      // arrange EXPLICITLY rather than leaning on hook order: the mapping must point at the domain
      // being removed, or the assertion below passes without the fix ever running
      await admin`UPDATE tenants SET custom_domain = ${SECOND} WHERE id = ${tenantId}`
      expect(await mapped()).toBe(SECOND)
      try {
        await removeCustomDomain(db, { tenantId, domain: SECOND })
        expect(await mapped(), 'the mapping follows to the surviving verified domain').toBe(DOMAIN)
        expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG })).toBe(`https://${DOMAIN}`)
      } finally {
        delete process.env.WKS_PUBLIC_BASE_URL
        await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at, last_ok_at)
          VALUES (${tenantId}, ${SECOND}, ${secondToken}, 'verified', now() + interval '1 minute', now())
          ON CONFLICT (tenant_id, domain) DO NOTHING`
      }
    }, 60_000)

    it('removing the LAST verified domain clears the mapping (no stale host left behind)', async () => {
      await admin`UPDATE custom_domains SET status = 'pending' WHERE domain = ${DOMAIN}`
      await admin`UPDATE tenants SET custom_domain = ${SECOND} WHERE id = ${tenantId}`
      try {
        await removeCustomDomain(db, { tenantId, domain: SECOND })
        expect(await mapped(), 'nothing verified is left, so nothing may resolve').toBeNull()
      } finally {
        await admin`UPDATE custom_domains SET status = 'verified' WHERE domain = ${DOMAIN}`
        await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at, last_ok_at)
          VALUES (${tenantId}, ${SECOND}, ${secondToken}, 'verified', now() + interval '1 minute', now())
          ON CONFLICT (tenant_id, domain) DO NOTHING`
      }
    }, 60_000)

    it('a mapping that drifted to NULL is repaired by a successful check', async () => {
      await admin`UPDATE tenants SET custom_domain = NULL WHERE id = ${tenantId}`
      await recheckCustomDomains({ resolveTxt: present() })
      expect(await mapped(), 'the sweep does not leave a verified row unresolvable').toBe(SECOND)
    }, 60_000)
  })

  describe('the sweep can undo its OWN demotion, and nobody else\'s pending row', () => {
    it('a domain that comes back is restored without an admin touching anything', async () => {
      const t0 = Date.now()
      const { demotedAtTick } = await runTicks(3, gone(), t0)
      expect(demotedAtTick).not.toBeNull()
      expect((await admin<{ auto_demoted_at: Date | null }[]>`SELECT auto_demoted_at FROM custom_domains WHERE domain = ${DOMAIN}`)[0]!.auto_demoted_at,
        'the sweep marks what IT demoted').not.toBeNull()

      const r = await recheckCustomDomains({ resolveTxt: present(), now: new Date(t0 + 10 * INTERVAL_MS) })
      expect(r.restored, 'our own resolver outage is not a one-way door').toContain(DOMAIN)
      const back = (await row())!
      expect(back.status).toBe('verified')
      expect(back.check_failures).toBe(0)
      expect(await mapped()).toBe(DOMAIN)
    }, 120_000)

    it('a pending row a HUMAN added is never auto-verified, even when its DNS matches', async () => {
      // the enrolment path must stay a person's decision: auto-verifying would issue a certificate
      // nobody asked for at a moment nobody chose
      const typed = `typed-${STAMP}.example.test`
      const typedToken = `tok3${STAMP}`
      await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status) VALUES (${tenantId}, ${typed}, ${typedToken}, 'pending')`
      try {
        const r = await recheckCustomDomains({ resolveTxt: async () => [[typedToken]] })
        expect(r.restored).not.toContain(typed)
        expect((await admin<{ status: string }[]>`SELECT status FROM custom_domains WHERE domain = ${typed}`)[0]!.status).toBe('pending')
      } finally {
        await admin`DELETE FROM custom_domains WHERE domain = ${typed}`.catch(() => {})
      }
    }, 60_000)
  })

  it('an admin who fixes DNS and presses Verify is not demoted by a sweep that read them earlier', async () => {
    // the TOCTOU the reviewer found: the write was conditional on status alone, and a successful
    // Verify leaves the status exactly as the stale sweep expects. The counter is the CAS value —
    // Verify resets it to 0, so the stale write finds nothing to update.
    await admin`UPDATE custom_domains SET check_failures = ${DEMOTE_AFTER - 1}, last_ok_at = now() - interval '30 days' WHERE domain = ${DOMAIN}`
    // hold the sweep INSIDE its DNS probe — read done, decision made, write not yet issued
    let releaseProbe = (): void => {}
    const probed = new Promise<void>((r) => { releaseProbe = r })
    const held = new Promise<void>((r) => { void probed.then(r) })
    const stale = recheckCustomDomains({
      resolveTxt: async () => { releaseProbe(); await held; await new Promise((r) => setTimeout(r, 50)); throw new Error('ENOTFOUND') },
    })
    await probed
    await verifyCustomDomain(db, { tenantId, domain: DOMAIN }, { resolveTxt: present() })
    const r = await stale
    expect(r.demoted, 'the admin just proved ownership — the older decision must not land').not.toContain(DOMAIN)
    expect((await row())!.status).toBe('verified')
    expect(await mapped()).toBe(DOMAIN)
  }, 60_000)

  it('a demoted domain is not demoted a SECOND time (two workers, or a replica, cannot double-fire)', async () => {
    const t0 = Date.now()
    const first = await runTicks(3, gone(), t0)
    expect(first.demotedAtTick).not.toBeNull()
    // the row is 'pending' now; every write in the sweep is conditional on status = 'verified'
    const settled = (await row())!.check_failures
    const again = await recheckCustomDomains({ resolveTxt: gone(), now: new Date(t0 + 30 * INTERVAL_MS) })
    expect(again.demoted, 'the second pass has nothing to demote').not.toContain(DOMAIN)
    expect((await row())!.check_failures, 'and it does not keep counting against a pending row').toBe(settled)
  }, 120_000)
})
