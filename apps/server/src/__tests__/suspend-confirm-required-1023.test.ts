// #1023: ADR-251's confirm_required warning for a HUMAN admin, asked and honoured all the way
// through the suspend route — not just inside the predicate a unit test calls directly.
//
// #925's review found the gap this closes: `925 the review`'s own break-check hard-coded
// `const confirm = true` inside `suspendMember` (member-suspension.ts) — the human caller's whole
// question, always answered yes — and every EXISTING pin stayed green, because none of them go
// through `suspendMember` or the HTTP route. The confirm_required pins at ways-in-after-822.test.ts
// call `assertNotLastExemptAdmin` as a bare function; `scim-auto-confirm-925.test.ts` is SCIM, which
// is always auto-confirmed and never asks the question this pin is about. Measured through the real
// route, real DB, real FGA, so a WIRING defect — not just a predicate defect — goes red.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
// Three separate exempt administrators — one per write under test, so the suspend test consuming
// its target (deactivating it) does not leave the demote/delete tests with nothing left to act on.
const WHO_SUSPEND = `susp1023-${STAMP}`
const WHO_DEMOTE = `demote1023-${STAMP}`
const WHO_DELETE = `del1023-${STAMP}`
const EXEMPT_ADMINS = [WHO_SUSPEND, WHO_DEMOTE, WHO_DELETE]

let app: FastifyInstance
let pt: PrivateTenant

const suspend = (sub: string, confirm?: boolean) =>
  app.inject({ method: 'POST', url: `/members/${sub}/suspend${confirm ? '?confirm=1' : ''}`, headers: pt.AUTH })
const demote = (sub: string, confirm?: boolean) =>
  app.inject({ method: 'PATCH', url: `/members/${sub}`, headers: pt.H, payload: { role: 'member', confirm } })
const remove = (sub: string, confirm?: boolean) =>
  app.inject({ method: 'DELETE', url: `/members/${sub}${confirm ? '?confirm=1' : ''}`, headers: pt.AUTH })

const memberState = async (sub: string) =>
  (await admin<{ deactivated_at: Date | null; role: string }[]>`
    SELECT deactivated_at, role FROM members WHERE tenant_id = ${pt.id} AND sub = ${sub}`)[0]

beforeAll(async () => {
  app = await buildApp()
  pt = await privateTenant(admin, 't1023')
  // dev-user (seated as admin by privateTenant) needs its own password so the DOOR-CLOSING guard
  // (assertClosingIsSafe, asked right after the exempt-floor guard this pin is about) sees a live way
  // in once each WHO is suspended/demoted/removed — without one, that guard would throw its OWN 409
  // (login_lockout) on the confirmed write, and these pins would never observe the sso_exempt floor
  // passing through on its own.
  await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
              VALUES (${pt.id}, 'dev-user', 'dev-user@t1023.test', 'x') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO tenant_login_prefs (tenant_id, sso_required, local_login_enabled)
              VALUES (${pt.id}, TRUE, TRUE) ON CONFLICT (tenant_id) DO UPDATE SET sso_required = TRUE`
  for (const sub of EXEMPT_ADMINS) {
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${pt.id}, ${sub}, ${`${sub}@t1023.test`}, 'admin')`
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                VALUES (${pt.id}, ${sub}, ${`${sub}@t1023.test`}, 'x')`
    // sso_exemptions is granted per-test (exemptAdmin(), below), not here: `assertNotLastExemptAdmin`
    // steps aside the moment ANOTHER exempt admin holds a key (correctly — that is the floor doing
    // its job), so pre-exempting all three at once would have each one see the OTHER two as that
    // other admin and never cross the floor at all (measured — the first cut of this fixture did
    // exactly that, and every write below went through unconfirmed).
    // #471: a member is a ROW and a tuple — a role-change/removal tuple write refuses ("cannot
    // delete a tuple which does not exist") without these.
    for (const relation of ['member', 'admin']) {
      await writeTuples(fgaClient, [{ user: `user:${sub}`, relation, object: `tenant:${pt.id}` }])
    }
  }
}, 60_000)

/** Grants the sso_exemptions row a target needs to BE the floor, right before the write that tests it. */
const exemptAdmin = (sub: string) =>
  admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${pt.id}, ${sub}, 'dev-user')`

afterAll(async () => {
  for (const sub of EXEMPT_ADMINS) {
    for (const relation of ['member', 'admin']) {
      await deleteTuples(fgaClient, [{ user: `user:${sub}`, relation, object: `tenant:${pt.id}` }]).catch(() => {})
    }
  }
  await pt.dispose() // also drops local_credentials / sso_exemptions / tenant_login_prefs / members for this tenant
  await app.close()
  await admin.end()
}, 60_000)

describe('#1023 the confirm_required warning survives the trip through the write, not just the predicate', () => {
  it('suspend: an unconfirmed write that would empty the sso-exempt floor is refused, and the row is untouched', async () => {
    await exemptAdmin(WHO_SUSPEND)
    const before = await memberState(WHO_SUSPEND)
    expect(before?.deactivated_at, 'fixture sanity: starts active').toBeNull()

    const refused = await suspend(WHO_SUSPEND)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('confirm_required')
    // `floor` (assertNotLastExemptAdmin's own field distinguishing this from
    // assertClosingIsSafe's `remainingKind`) does not survive Fastify's default error
    // serialization — the message is what is actually on the wire, and it names the
    // exempt-administrator floor specifically, not the generic "one way in left" sentence.
    expect(refused.json().message, 'this must be the sso_exempt floor, not last_signin_admin').toMatch(/exempt ADMINISTRATOR/)

    const after = await memberState(WHO_SUSPEND)
    expect(after?.deactivated_at, 'a refused write must not have touched the row').toBeNull()
  }, 30_000)

  it('suspend: the SAME write, confirmed, goes through', async () => {
    const confirmed = await suspend(WHO_SUSPEND, true)
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().suspended).toBe(true)

    const after = await memberState(WHO_SUSPEND)
    expect(after?.deactivated_at, 'a confirmed write must actually suspend').not.toBeNull()
  }, 30_000)

  it('demote (PATCH): an unconfirmed role change is refused, and confirmed it goes through', async () => {
    await exemptAdmin(WHO_DEMOTE)
    const refused = await demote(WHO_DEMOTE)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('confirm_required')
    expect((await memberState(WHO_DEMOTE))?.role, 'a refused write must not have changed the role').toBe('admin')

    const confirmed = await demote(WHO_DEMOTE, true)
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect((await memberState(WHO_DEMOTE))?.role, 'a confirmed write must actually demote').toBe('member')
  }, 30_000)

  it('remove (DELETE): an unconfirmed removal is refused, and confirmed it goes through', async () => {
    await exemptAdmin(WHO_DELETE)
    const refused = await remove(WHO_DELETE)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('confirm_required')
    expect(await memberState(WHO_DELETE), 'a refused write must not have removed the row').toBeDefined()

    const confirmed = await remove(WHO_DELETE, true)
    expect(confirmed.statusCode, confirmed.body).toBe(204)
    expect(await memberState(WHO_DELETE), 'a confirmed write must actually remove the row').toBeUndefined()
  }, 30_000)
})
