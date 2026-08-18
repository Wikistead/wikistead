// #721 / ADR-230 §5: a downgrade that drops `customDomain` actually takes the domain away.
//
// ADR-065 promised three-point revocation on release OR entitlement loss. The release half worked;
// the other half never ran, because `removeCustomDomain` had exactly one caller — the button a
// human presses — and the downgrade batch did not mention custom domains at all. A downgraded
// tenant kept its public address, resolving to a plan that no longer included it.
//
// The tenant is PRIVATE to this file (#700): the batch commits plan changes and the reconciler is
// global, so sharing tenant_dev would let this file's downgrades land on whatever else is running.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { reconcilePlans } from '../scripts/plan-reconcile.js'
import { UNLIMITED, registerEntitlementsResolver, resetEntitlementsResolver } from '@wikistead/entitlements'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let t: Awaited<ReturnType<typeof privateTenant>>

const seedDomain = (domain: string, status: 'verified' | 'pending' = 'verified') =>
  admin`INSERT INTO custom_domains (tenant_id, domain, status, verification_token, verified_at)
        VALUES (${t.id}, ${domain}, ${status}, 'tok', ${status === 'verified' ? admin`now()` : null})`
const domainRows = async () =>
  (await admin<{ domain: string }[]>`SELECT domain FROM custom_domains WHERE tenant_id = ${t.id}`).map((r) => r.domain)
const mapping = async () =>
  (await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${t.id}`)[0]!.custom_domain

const downgradeTo = (plan: string) =>
  admin`UPDATE tenants SET plan = 'team', pending_plan = ${plan}, pending_plan_at = now() WHERE id = ${t.id}`

beforeAll(async () => { t = await privateTenant(admin, 'cd721') }, 60_000)
afterEach(async () => {
  resetEntitlementsResolver()
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`UPDATE tenants SET plan = 'team', pending_plan = NULL, pending_plan_at = NULL, custom_domain = NULL WHERE id = ${t.id}`.catch(() => {})
})
afterAll(async () => { await t.dispose(); await admin.end(); await pool.end() }, 60_000)

describe('#721: custom domains are revoked when the plan loses them', () => {
  it('both domains go, the mapping is RE-DERIVED, and the batch reports them', async () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customDomain: false }))
    await seedDomain('docs.cd721.test')
    await seedDomain('help.cd721.test')
    await admin`UPDATE tenants SET custom_domain = 'help.cd721.test' WHERE id = ${t.id}`
    await downgradeTo('free')

    const { domainsRevoked } = await reconcilePlans(admin, { graceSeconds: 0 })

    expect(await domainRows(), 'the rows are the first of ADR-065s three points').toEqual([])
    expect(await mapping(), 'the mapping is derived from the rows, never hand-cleared (#576)').toBeNull()
    expect(domainsRevoked.sort(), 'the batch reports them so certs can be reconciled until #235').toEqual(
      ['docs.cd721.test', 'help.cd721.test'],
    )
  }, 60_000)

  it('a downgrade to a plan that KEEPS customDomain loses nothing', async () => {
    // The predicate reads the NEW plan, rather than assuming that any downgrade drops everything.
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customDomain: true }))
    await seedDomain('stay.cd721.test')
    await downgradeTo('pro')

    const { committed, domainsRevoked } = await reconcilePlans(admin, { graceSeconds: 0 })

    expect(committed).toBe(1)
    expect(domainsRevoked).toEqual([])
    expect(await domainRows()).toEqual(['stay.cd721.test'])
  }, 60_000)

  it('re-upgrading does not silently restore a revoked domain', async () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customDomain: false }))
    await seedDomain('gone.cd721.test')
    await downgradeTo('free')
    await reconcilePlans(admin, { graceSeconds: 0 })

    // Back up to a plan that includes it: unlike the seat freeze, this is NOT reversible. DNS may
    // have moved on, and re-asserting ownership without a fresh challenge is the takeover ADR-065's
    // revocation exists to prevent — the tenant must add and verify again.
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customDomain: true }))
    await admin`UPDATE tenants SET plan = 'free', pending_plan = 'team', pending_plan_at = now() WHERE id = ${t.id}`
    await reconcilePlans(admin, { graceSeconds: 0 })

    expect(await domainRows()).toEqual([])
  }, 60_000)

  it('is idempotent: a second run revokes nothing and does not error', async () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customDomain: false }))
    await seedDomain('twice.cd721.test')
    await downgradeTo('free')

    const first = await reconcilePlans(admin, { graceSeconds: 0 })
    const second = await reconcilePlans(admin, { graceSeconds: 0 })

    expect(first.domainsRevoked).toEqual(['twice.cd721.test'])
    expect(second.committed, 'the commit already happened; nothing is pending').toBe(0)
    expect(second.domainsRevoked).toEqual([])
  }, 60_000)

  it('a self-hosted build (customDomain unlimited) revokes nothing', async () => {
    // No Cloud resolver registered → UNLIMITED, the same shape the seat freeze no-ops on.
    await seedDomain('selfhost.cd721.test')
    await downgradeTo('free')

    const { domainsRevoked } = await reconcilePlans(admin, { graceSeconds: 0 })

    expect(domainsRevoked).toEqual([])
    expect(await domainRows()).toEqual(['selfhost.cd721.test'])
  }, 60_000)
})
