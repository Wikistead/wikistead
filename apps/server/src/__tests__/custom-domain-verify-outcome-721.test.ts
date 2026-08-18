// #721 ③: what the VERIFY route tells the caller when the DNS record is not there yet, and
// what actually changes when it is.
//
// The screen used to answer every failed verification with "something went wrong", so the reader
// suspected the product rather than their own DNS. The fix reads `code` off the error body — and
// nothing pinned that the code SURVIVES THE WIRE. `verifyCustomDomain` throws an Error with
// `code: 'not_verified'` hung on it, and whether that reaches the client is a property of the
// framework's error serialisation and this app's error handler, not of the throw. Fix the screen
// against a body that never carries a code and the screen is fixed vacuously.
//
// The second half is the state after a SUCCESSFUL verification, which could not check by hand
// (`docs.example.com` belongs to somebody else, so no TXT record can be published for it): the row
// turns verified AND `tenants.custom_domain` starts pointing at it, which is what makes the host
// resolve to this tenant (ADR-016).
//
// The success half goes through the ownership check's own injection seam and then reads the result
// back THROUGH THE LIST ROUTE, which is the one the screen actually reads. Module-mocking the DNS
// primitive was tried first and is not available here: the suite's setup file imports the EE root,
// which re-exports `buildApp`, so every route module is already instantiated (and bound to the real
// primitive) before a test file's mocks are registered.
//
// The refusal half needs no stub at all. `.example` is reserved and resolves for nobody, and the
// primitive turns every DNS failure into "not present", so the answer is the same offline.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { verifyCustomDomain } from '../routes/custom-domains.js'
import type { Tenant } from '@wikistead/types'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const DOMAIN = `wiki-721-${STAMP}.example`
const TOKEN = `tok-${STAMP}`
let pt: PrivateTenant
let app: FastifyInstance
let db: TenantDb

const verify = () =>
  app.inject({ method: 'POST', url: `/admin/custom-domains/${DOMAIN}/verify`, headers: pt.H, payload: '{}' })
/** The DNS owner published the token: the shape the ownership check takes from a resolver. */
const published = async () => [[TOKEN]] as string[][]
const listed = async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/custom-domains', headers: pt.AUTH })
  return (res.json() as { domains: { domain: string; status: string }[] }).domains
}
const rowStatus = async () => {
  const [r] = await adminPool<{ status: string }[]>`SELECT status FROM custom_domains WHERE domain = ${DOMAIN}`
  return r?.status
}
const mappedDomain = async () => {
  const [r] = await adminPool<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${pt.id}`
  return r?.custom_domain
}

beforeAll(async () => {
  pt = await privateTenant(adminPool, 't721v')
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb({ id: pt.id, slug: pt.slug, plan: 'business', isolation: 'logical' } as Tenant)
}, 180_000)

beforeEach(async () => {
  await adminPool`DELETE FROM custom_domains WHERE domain = ${DOMAIN}`.catch(() => {})
  await adminPool`UPDATE tenants SET custom_domain = NULL WHERE id = ${pt.id}`.catch(() => {})
  await adminPool`INSERT INTO custom_domains (tenant_id, domain, verification_token, status)
                  VALUES (${pt.id}, ${DOMAIN}, ${TOKEN}, 'pending')`
})

afterAll(async () => {
  await adminPool`DELETE FROM custom_domains WHERE domain = ${DOMAIN}`.catch(() => {})
  await adminPool`UPDATE tenants SET custom_domain = NULL WHERE id = ${pt.id}`.catch(() => {})
  await pt.dispose()
  await db.release()
  await app.close()
  await adminPool.end()
  await pool.end()
}, 120_000)

describe('#721 ③: the verify route names the failure it hit', () => {
  it('answers a missing DNS record with the not_verified CODE in the body, not only a 400', async () => {
    const res = await verify()
    expect(res.statusCode, res.body).toBe(400)
    const body = res.json() as { code?: string }
    // The screen branches on exactly this string. Without it there is nothing to tell "your record
    // is not published yet" apart from any other 400, and the reader gets the generic failure again.
    expect(body.code, `the body was ${res.body}`).toBe('not_verified')
  })

  it('changes nothing when it refuses: the row stays pending and no host starts resolving', async () => {
    await verify()
    expect(await rowStatus()).toBe('pending')
    expect(await mappedDomain()).toBeNull()
  })
})

describe('#721: what a successful verification actually switches', () => {
  it('turns the row verified, says so on the route the screen reads, and points host resolution here', async () => {
    expect((await listed())[0]).toMatchObject({ domain: DOMAIN, status: 'pending' })
    await verifyCustomDomain(db, { tenantId: pt.id, domain: DOMAIN }, { resolveTxt: published })
    expect(await rowStatus()).toBe('verified')
    // The screen decides what to draw from THIS, not from the row: a verified domain stops showing
    // the DNS instruction and the Verify button, so a list that kept saying "pending" would leave
    // the reader publishing a record that is already accepted.
    expect((await listed())[0]).toMatchObject({ domain: DOMAIN, status: 'verified' })
    // ADR-016: `tenants.custom_domain` is what host→tenant resolution reads, so this column IS the
    // switch. A row that says "verified" while the column stays null is a screen telling the truth
    // about a domain that serves nobody.
    expect(await mappedDomain()).toBe(DOMAIN)
  })
})
