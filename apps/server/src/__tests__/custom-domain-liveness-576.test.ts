// #576: a domain proved ours once and was never asked again, so a domain that stopped being ours
// kept winning tenantBaseUrl and every notification mail carried a link to a dead host. The sweep
// re-runs the SAME DNS-TXT ownership primitive the manual verify uses and demotes verified→pending
// — but only after consecutive failures AND a grace window, because a resolver hiccup must never
// unpick a customer's domain. What the pins hold:
//   - a live domain resets its failure counter (and is never demoted);
//   - failures below the threshold, or inside the grace window, do NOT demote (the abuse guard);
//   - a sustained failure demotes REVERSIBLY: the row and its token survive, tenants.custom_domain
//     is cleared, and tenantBaseUrl falls back to the platform URL — the actual bug;
//   - verifying again restores it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { recheckCustomDomains, verifyCustomDomain } from '../routes/custom-domains.js'
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

let tenantId = ''
let db: TenantDb
let token = ''

// the TXT resolver, switchable per case: "the record is there" vs "the domain is gone"
const present = (): ((d: string) => Promise<string[][]>) => async () => [[token]] // the record holds the TOKEN; CHALLENGE_PREFIX is the record NAME
const gone = (): ((d: string) => Promise<string[][]>) => async () => { throw new Error('ENOTFOUND') }

const row = async () =>
  (await admin<{ status: string; check_failures: number }[]>`SELECT status, check_failures FROM custom_domains WHERE domain = ${DOMAIN}`)[0]
const mapped = async () =>
  (await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`)[0]?.custom_domain

beforeAll(async () => {
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: `cd576-admin-${STAMP}` } })
  tenantId = t.tenantId
  db = await acquireTenantDb(asTenant(tenantId))
  token = 'tok' + STAMP
  await admin`INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at)
    VALUES (${tenantId}, ${DOMAIN}, ${token}, 'verified', now())`
  await admin`UPDATE tenants SET custom_domain = ${DOMAIN} WHERE id = ${tenantId}`
}, 60_000)

afterEach(async () => {
  await admin`UPDATE custom_domains SET status = 'verified', check_failures = 0, last_checked_at = NULL, verified_at = now() WHERE domain = ${DOMAIN}`
  await admin`UPDATE tenants SET custom_domain = ${DOMAIN} WHERE id = ${tenantId}`
})

afterAll(async () => {
  await db.release()
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end(); await pool.end()
}, 60_000)

describe('#576: a custom domain that stopped being ours stops deciding link hosts', () => {
  it('a live domain survives and its failure counter resets', async () => {
    await admin`UPDATE custom_domains SET check_failures = 2 WHERE domain = ${DOMAIN}`
    const r = await recheckCustomDomains(admin, { resolveTxt: present() })
    expect(r.demoted).not.toContain(DOMAIN)
    expect((await row())!).toMatchObject({ status: 'verified', check_failures: 0 })
  }, 60_000)

  it('failures below the threshold, and failures inside the grace window, do NOT demote', async () => {
    // one failure, long past the grace window: counted, not demoted
    await admin`UPDATE custom_domains SET verified_at = now() - interval '30 days' WHERE domain = ${DOMAIN}`
    await recheckCustomDomains(admin, { resolveTxt: gone() })
    expect((await row())!).toMatchObject({ status: 'verified', check_failures: 1 })

    // enough failures, but the last success is RECENT: the outage is younger than the grace window
    await admin`UPDATE custom_domains SET check_failures = 9, last_checked_at = now() WHERE domain = ${DOMAIN}`
    await recheckCustomDomains(admin, { resolveTxt: gone() })
    expect((await row())!.status, 'a short outage never unpicks a customer domain').toBe('verified')
    expect(await mapped()).toBe(DOMAIN)
  }, 60_000)

  it('a sustained failure demotes reversibly, and the canonical URL falls back to the platform', async () => {
    process.env.WKS_PUBLIC_BASE_URL = 'https://wikistead.example.com'
    try {
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG }), 'before: the custom domain wins').toBe(`https://${DOMAIN}`)

      await admin`UPDATE custom_domains SET check_failures = 2, last_checked_at = now() - interval '30 days' WHERE domain = ${DOMAIN}`
      const r = await recheckCustomDomains(admin, { resolveTxt: gone() })
      expect(r.demoted, 'the third consecutive failure past the grace window').toContain(DOMAIN)

      const after = (await row())!
      expect(after.status, 'demoted, not deleted — the admin keeps their configuration').toBe('pending')
      expect((await admin<{ verification_token: string }[]>`SELECT verification_token FROM custom_domains WHERE domain = ${DOMAIN}`)[0]!.verification_token,
        'the token survives, so Verify works without re-adding').toBe(token)
      expect(await mapped(), 'host→tenant resolution stops pointing at the dead name').toBeNull()
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG }), 'links fall back instead of pointing at a dead host').toBe(`https://${SLUG}.wikistead.example.com`)

      // and the reverse direction works: proving ownership again restores everything
      await verifyCustomDomain(db, { tenantId, domain: DOMAIN }, { resolveTxt: present() })
      expect((await row())!.status).toBe('verified')
      expect(await tenantBaseUrl(admin, { id: tenantId, slug: SLUG })).toBe(`https://${DOMAIN}`)
    } finally {
      delete process.env.WKS_PUBLIC_BASE_URL
    }
  }, 60_000)
})
