// #627 / ADR-213: an admin can suspend a member, and bring them back.
//
// The behaviour was already complete and already correct — it just had no door an admin could walk
// through, because the only callers were SCIM (EE) and the billing reconcile. So what is measured here is
// the door and the things that had to be true around it: the grants really go, a rebuild does not put
// them back, the role cannot be changed underneath a suspension, and the console cannot undo what the
// directory did.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { grantsShouldBeRebuilt, isScimSuspension } from '../auth/member-suspension.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const WHO = `susp627-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const JSON_H = { ...H, 'content-type': 'application/json' }

let app: FastifyInstance

const state = async (sub: string) =>
  (await admin<{ deactivated_at: Date | null; deactivation_reason: string | null; groups: string[] | null }[]>`
    SELECT deactivated_at, deactivation_reason, groups FROM members WHERE tenant_id = ${TENANT} AND sub = ${sub}`)[0]!
// asked of the store directly: `checkRelation`'s ResourceRef covers space/page, and the tenant grants
// are what a suspension takes away
const tenantHas = async (sub: string, relation: string): Promise<boolean> =>
  (await fgaClient.check({ user: `user:${sub}`, relation, object: `tenant:${TENANT}` })).allowed === true
const isMember = (sub: string) => tenantHas(sub, 'member')

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await seatMembers(admin, TENANT, [WHO])
  // #471: a member is a ROW and a tuple. Seating only the row makes the suspension's delete refuse
  // ("cannot delete a tuple which does not exist") — which is the right answer to a fixture that never
  // granted anything, and the wrong shape for a test about taking a real membership away.
  await ensureMembers(TENANT, [WHO])
  await admin`UPDATE members SET groups = ${admin.array(['wiki Editors'])} WHERE tenant_id = ${TENANT} AND sub = ${WHO}`
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${TENANT} AND owner_user_id = ${WHO}`.catch(() => {})
  await deleteTuples(fgaClient, memberTuples(TENANT, [WHO])).catch(() => {})
  await unseatMembers(admin, TENANT, [WHO])
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

const suspend = (sub: string) => app.inject({ method: 'POST', url: `/members/${sub}/suspend`, headers: H })
const reactivate = (sub: string) => app.inject({ method: 'POST', url: `/members/${sub}/reactivate`, headers: H })

describe('#627: an admin can suspend a member', () => {
  it('strips the grants, records the reason, and holds the seat', async () => {
    // the member is granted first, so "the tuple went away" is a change rather than an absence
    const before = await isMember(WHO)
    expect(before, 'the fixture really is a member before it is suspended').toBe(true)

    const res = await suspend(WHO)
    expect(res.statusCode, res.body).toBe(200)

    const row = await state(WHO)
    expect(row.deactivated_at, 'the row records the suspension').not.toBeNull()
    expect(row.deactivation_reason, "an admin's suspension is its own reason — SCIM's is not rewritten").toBe('admin')
    expect(row.groups, 'ruling 3: groups are cleared, and the UI says so rather than letting it be found').toEqual([])
    expect(await isMember(WHO), 'the membership tuple is gone').toBe(false)

    // ruling 1: the seat is HELD. `billableMemberCount` excludes only `reason='scim'`, and that
    // condition is deliberately untouched — otherwise "suspend somebody when the cap is reached" is a
    // way to avoid paying for a seat.
    const [{ n }] = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM members
      WHERE tenant_id = ${TENANT} AND sub = ${WHO} AND deactivation_reason IS DISTINCT FROM 'scim'`
    expect(Number(n), 'an admin suspension still counts against the plan').toBe(1)
  })

  it('refuses a role change while the member is suspended', async () => {
    // The gap this closes: PATCH did not read `deactivated_at`, so promoting a suspended member wrote
    // `tenant#admin` at once — restoring a tuple the suspension removed and lighting up every relation
    // that unions `or admin`, while `tenant#member` stayed false.
    const res = await app.inject({
      method: 'PATCH', url: `/members/${WHO}`, headers: JSON_H, payload: { role: 'admin' },
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'member_suspended' })
    expect(await tenantHas(WHO, 'admin'), 'and no admin tuple was written').toBe(false)
  })

  it('is idempotent, and says which it was', async () => {
    const again = await suspend(WHO)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ alreadySuspended: true })
  })

  it('will not undo what the directory did', async () => {
    // ruling 4: a SCIM removal is not the console's to reverse — a tenant whose IdP dropped somebody
    // could otherwise put them back, admin grant and all, from inside the product.
    await admin`UPDATE members SET deactivation_reason = 'scim' WHERE tenant_id = ${TENANT} AND sub = ${WHO}`
    const res = await reactivate(WHO)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'not_your_suspension' })
    await admin`UPDATE members SET deactivation_reason = 'admin' WHERE tenant_id = ${TENANT} AND sub = ${WHO}`
  })

  it('brings the member back, with the membership tuple', async () => {
    const res = await reactivate(WHO)
    expect(res.statusCode, res.body).toBe(200)
    const row = await state(WHO)
    expect(row.deactivated_at, 'the row is clear').toBeNull()
    expect(await isMember(WHO), 'the membership grant is back').toBe(true)
  })

  it('refuses to suspend the last admin, and refuses to suspend yourself', async () => {
    const last = await suspend('dev-user')
    expect(last.statusCode, last.body).toBe(409)
    // dev-token authenticates AS dev-user, so this is both refusals at once; the code says which one
    // answered first, and self-suspension is the one that fires before any counting happens.
    expect(['self_suspend', 'last_admin']).toContain(last.json().code)
  })

  it('answers 404 for somebody who is not here', async () => {
    expect((await suspend('susp627-nobody')).statusCode).toBe(404)
    expect((await reactivate('susp627-nobody')).statusCode).toBe(404)
  })
})

describe('#627: the two predicates are opposites on purpose', () => {
  // Written during review as one shared "is this deactivated" question and refused twice: the two sites
  // want different answers for a reason neither has seen. Rebuilding defaults to NOT rebuilding; refusing
  // work defaults to NOT refusing. One predicate makes one of them fail open.
  it('a rebuild restores a billing freeze and leaves suspensions stripped', () => {
    expect(grantsShouldBeRebuilt(null, null), 'an active member').toBe(true)
    expect(grantsShouldBeRebuilt(new Date(), 'downgrade_freeze'), 'a freeze keeps its tuples (#131)').toBe(true)
    expect(grantsShouldBeRebuilt(new Date(), 'admin'), 'an admin suspension stays stripped').toBe(false)
    expect(grantsShouldBeRebuilt(new Date(), 'scim'), 'a directory removal stays stripped').toBe(false)
    expect(grantsShouldBeRebuilt(new Date(), 'something_new'), 'an unknown reason rebuilds nothing').toBe(false)
  })

  it("and SCIM calls only its OWN suspension already done", () => {
    expect(isScimSuspension('scim')).toBe(true)
    expect(isScimSuspension('admin'), "an admin's decision is not SCIM's to consider handled").toBe(false)
    expect(isScimSuspension('downgrade_freeze')).toBe(false)
    expect(isScimSuspension('something_new'), 'an unknown reason is not "already done"').toBe(false)
  })

  // #831 rewrote what this asks. It used to accept the allowlist being INLINED in the rebuild script,
  // because that is how it was written — and the sibling copy in the same file, `groupFgaId`, had
  // silently drifted by one byte for four months under an identical "MUST match" comment. A pin that
  // blesses a copy is a pin that will one day pass over the copy going wrong, so what is asked now is
  // that there is no copy.
  it('the rebuild script IMPORTS the predicate rather than carrying its own', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(import.meta.dirname, '..', '..', '..', '..', 'infra', 'openfga', 'resync.ts'), 'utf8')
    expect(src, 'the resync consults the predicate').toMatch(/grantsShouldBeRebuilt/)
    expect(src, 'from the file that owns it').toMatch(/import \{ grantsShouldBeRebuilt \} from/)
    expect(src, 'a local allowlist is the copy coming back').not.toMatch(/const REASONS_THAT_KEEP_GRANTS/)
  })
})
