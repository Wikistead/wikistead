// Integration test (real Postgres) — #101/ADR-034 addendum: the enrol-domain registry + the assembled
// enrol config. The trust boundary: a domain admits an enrol ONLY once DNS ownership is proven (the SAME
// challenge as custom domains), and getEnrollConfig exposes ONLY verified domains as verifiedDomains.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { addEnrollDomain, verifyEnrollDomain, removeEnrollDomain, listEnrollDomains, getEnrollConfig } from '../auth/enroll-domains.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const DOMAIN = `corp-${Date.now().toString(36)}.example.com`
let db: TenantDb

const resolverReturning = (token: string) => async () => [[token]] as string[][]
const txtFor = async (domain: string) => {
  const [r] = await admin<{ verification_token: string }[]>`SELECT verification_token FROM enroll_domains WHERE domain = ${domain}`
  return r.verification_token
}
const setSettings = (policy: string, groups: string[]) => admin`
  INSERT INTO tenant_settings (tenant_id, enroll_policy, enroll_allowed_groups)
  VALUES (${TENANT}, ${policy}, ${admin.array(groups)})
  ON CONFLICT (tenant_id) DO UPDATE SET enroll_policy = EXCLUDED.enroll_policy, enroll_allowed_groups = EXCLUDED.enroll_allowed_groups
`

beforeAll(async () => { db = await acquireTenantDb(asTenant(TENANT)) }, 30_000)
afterEach(async () => {
  await admin`DELETE FROM enroll_domains WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`UPDATE tenant_settings SET enroll_policy = 'invite_only', enroll_allowed_groups = '{}' WHERE tenant_id = ${TENANT}`.catch(() => {})
})
afterAll(async () => { await db.release(); await admin.end(); await pool.end() }, 30_000)

describe('enrol domains + config (#101/ADR-034)', () => {
  it('add creates a PENDING domain (not verified) with a DNS challenge', async () => {
    const v = await addEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN })
    expect(v).toMatchObject({ domain: DOMAIN, verified: false, verifiedAt: null })
    expect(v.challengeRecord).toBe(`_wikistead-challenge.${DOMAIN}`)
    expect(v.challengeValue.length).toBeGreaterThan(10)
  })

  it('verify sets verified_at ONLY when the DNS TXT token matches; a mismatch stays pending', async () => {
    await addEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN })
    await expect(verifyEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN }, { resolveTxt: resolverReturning('wrong-token') }))
      .rejects.toMatchObject({ statusCode: 400, code: 'not_verified' })
    expect((await listEnrollDomains(db))[0]!.verified).toBe(false) // still pending

    await verifyEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN }, { resolveTxt: resolverReturning(await txtFor(DOMAIN)) })
    expect((await listEnrollDomains(db))[0]!.verified).toBe(true)
  })

  it('getEnrollConfig exposes ONLY verified domains as verifiedDomains (the trust boundary)', async () => {
    await setSettings('domain', [])
    await addEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN }) // pending
    let cfg = await getEnrollConfig(db)
    expect(cfg.policy).toBe('domain')
    expect(cfg.verifiedDomains).not.toContain(DOMAIN) // a PENDING domain never counts

    await verifyEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN }, { resolveTxt: resolverReturning(await txtFor(DOMAIN)) })
    cfg = await getEnrollConfig(db)
    expect(cfg.verifiedDomains).toContain(DOMAIN) // verified → now a trusted enrol domain
  })

  it('getEnrollConfig reads the policy + allowed groups; unknown policy falls back to invite_only', async () => {
    await setSettings('groups', ['engineering', 'admins'])
    let cfg = await getEnrollConfig(db)
    expect(cfg.policy).toBe('groups')
    expect(cfg.allowedGroups).toEqual(expect.arrayContaining(['engineering', 'admins']))

    await admin`UPDATE tenant_settings SET enroll_policy = 'garbage' WHERE tenant_id = ${TENANT}`
    cfg = await getEnrollConfig(db)
    expect(cfg.policy).toBe('invite_only') // a bad stored value never widens access
  })

  it('remove drops the enrol domain', async () => {
    await addEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN })
    await removeEnrollDomain(db, { tenantId: TENANT, domain: DOMAIN })
    expect(await listEnrollDomains(db)).toEqual([])
  })
})
