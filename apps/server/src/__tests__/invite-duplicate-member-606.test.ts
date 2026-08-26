// #606: a password invite to somebody who is ALREADY a member makes a second person, not a password.
//
// `acceptLocalInvite` always mints a fresh `wlocal_` sub, so an admin trying to give an existing member
// a password entrance instead produced a second member row sharing their address, a second seat, and a
// second set of FGA tuples. Both people then appear in the member list with the same email and nothing
// on screen says which one is which.
//
// Measured on real data at BOTH ends, because they fail differently:
//   - ISSUE time is where the admin can be told, and is where the fix belongs;
//   - ACCEPTANCE still has to hold, because a link issued while the address was free stays valid after
//     that person joins by another route (SCIM, a first OIDC sign-in). Pinning only the issue path would
//     leave the race that produced the duplicate in the first place.
//
// The count is the assertion. A guard that returns the right status while still writing a row would
// pass a pin that only read the status code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createInvite, acceptLocalInvite, acceptInvite } from '../auth/invites.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const PASSWORD = 'duplicate-member-passphrase-1'

let app: FastifyInstance
let db: TenantDb
const emails: string[] = []
const subs: string[] = []

const email = (n: string) => { const e = `dup606-${n}-${STAMP}@e2e.test`; emails.push(e); return e }
const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
const makeInvite = (addr: string) =>
  createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member', kind: 'local' })
const membersWith = async (addr: string): Promise<number> =>
  Number((await adminPool<{ n: string }[]>`
    SELECT count(*) AS n FROM members WHERE tenant_id = ${TENANT} AND lower(email) = ${addr.toLowerCase()}`)[0]!.n)

/** An existing member who did NOT arrive by password invite — the SCIM / OIDC shape of the problem. */
let seated = 0
const seatMember = async (addr: string): Promise<string> => {
  // a counter, not something derived from the address: two of these addresses are the same length, and
  // deriving the sub from that made the second INSERT a no-op against the first person's row
  const sub = `dup606-existing-${STAMP}-${++seated}`
  subs.push(sub)
  await adminPool`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${addr}, 'member')
                  ON CONFLICT (tenant_id, sub) DO NOTHING`
  return sub
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  for (const e of emails) {
    const creds = await adminPool<{ member_sub: string }[]>`SELECT member_sub FROM local_credentials WHERE identifier = ${e}`
    for (const { member_sub } of creds) {
      await adminPool`DELETE FROM local_credentials WHERE member_sub = ${member_sub}`.catch(() => {})
      await adminPool`DELETE FROM members WHERE sub = ${member_sub}`.catch(() => {})
    }
    await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${e}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND lower(email) = ${e.toLowerCase()}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#606: an invite to an existing member is refused, and never seats them twice', () => {
  it('the issue is refused, with a reason an admin can read', async () => {
    const addr = email('issue')
    await seatMember(addr)
    await expect(makeInvite(addr)).rejects.toMatchObject({ statusCode: 400, code: 'already_member' })
    const err = await makeInvite(addr).catch((e: Error) => e)
    expect((err as Error).message, 'not a generic failure — it says what happened').toMatch(/already belongs to a member/i)
    expect(await membersWith(addr), 'and nobody was added').toBe(1)
  }, 120_000)

  it('the same address in a different case is the same person', async () => {
    // The identifier is lower-cased on acceptance, so `Ada@…` and `ada@…` are one sign-in name. A guard
    // that compared them literally would wave through the very duplicate it exists to stop.
    const addr = email('case')
    await seatMember(addr.toUpperCase())
    await expect(makeInvite(addr.toLowerCase())).rejects.toMatchObject({ statusCode: 400, code: 'already_member' })
  }, 120_000)

  it('an invite issued BEFORE they joined does not seat them again when accepted', async () => {
    // The race the issue-time check cannot see: the link is valid when it is written and the person
    // arrives by another route afterwards. Accepting must not mint a second identity for them.
    const addr = email('race')
    const { token } = await makeInvite(addr) // free at this point
    await seatMember(addr) // …and now they are here, via SCIM or a first OIDC sign-in
    const before = await membersWith(addr)
    expect(before, 'one of them so far').toBe(1)

    const result = await acceptLocalInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, PASSWORD)
    expect(result.ok, 'the link no longer works — the same answer as expired or consumed').toBe(false)
    expect(await membersWith(addr), 'and no second member was created').toBe(1)
    const creds = await adminPool`SELECT 1 FROM local_credentials WHERE identifier = ${addr.toLowerCase()}`
    expect(creds.length, 'no credential was left behind for a member that does not exist').toBe(0)
  }, 120_000)

  it('an address nobody holds still works, so the guard did not close the door', async () => {
    const addr = email('fresh')
    const { token } = await makeInvite(addr)
    const result = await acceptLocalInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, PASSWORD)
    expect(result.ok, 'a genuine invite is unaffected').toBe(true)
    expect(await membersWith(addr)).toBe(1)
  }, 120_000)
})

// ADR-259 §3.2/§3.4/§5: #606 built this guard on the LOCAL invite door only (issue-time AND accept-time
// both call memberWithEmail there). An OIDC invite asked NOTHING at either end — issuing one, then
// accepting it as the identity provider's own sign-in, seated a second person sharing the address. The
// fortress (enrolUnderSeatCap) now closes it for every caller; this measures the OIDC one specifically,
// because it is the caller that had ZERO coverage before this ADR.
describe('#606 → ADR-259 §3.2: an OIDC invite acceptance never seats a second person for a held address', () => {
  const makeOidcInvite = (addr: string) =>
    createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member' }) // kind defaults to 'oidc'

  it('accepting an OIDC invite for an address a member already holds answers false — the same uniform outcome as a bad token', async () => {
    const addr = email('oidc-race')
    const { token } = await makeOidcInvite(addr) // free at this point — issuing an OIDC invite asks nothing
    await seatMember(addr) // …and now somebody is here, via SCIM or a first sign-in through another door
    expect(await membersWith(addr), 'one of them so far').toBe(1)

    const oidcSub = `dup606-oidc-${STAMP}`
    subs.push(oidcSub)
    const ok = await acceptInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, { sub: oidcSub, email: addr })
    expect(ok, 'the same "this link no longer works" answer as an expired or consumed token').toBe(false)
    expect(await membersWith(addr), 'and no second member was created').toBe(1)
    expect((await adminPool`SELECT 1 FROM members WHERE tenant_id = ${TENANT} AND sub = ${oidcSub}`).length,
      'nothing was seated under the identity that tried to accept').toBe(0)
  }, 120_000)

  it('an OIDC invite for an address nobody holds still works — the guard did not close the door', async () => {
    const addr = email('oidc-fresh')
    const { token } = await makeOidcInvite(addr)
    const oidcSub = `dup606-oidc-fresh-${STAMP}`
    subs.push(oidcSub)
    const ok = await acceptInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, { sub: oidcSub, email: addr })
    expect(ok, 'a genuine invite is unaffected').toBe(true)
    expect(await membersWith(addr)).toBe(1)
  }, 120_000)
})
