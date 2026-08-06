// #654 / ADR-219 §7: a second factor lives and dies with the credential it guards.
//
// Two of the three paths here are consequences; the third is a DECISION, and it is the one worth a pin.
//
// Removing a password (#626) and removing a member both wipe every other credential the person held —
// the reason is concrete: `sub`s are reused, so a row left behind attaches to whoever holds that `sub`
// next. Factors join that list.
//
// SCIM's deprovision does NOT. It is a SOFT suspension: it revokes API keys and destroys sessions, but
// leaves `local_credentials` untouched and keeps the `sub`, so `reactivateMember` brings the same person
// back with the same password. Factors follow that, because deleting them would quietly turn suspension
// into "suspend and reset their authenticator" — a different act, done under a name that does not say so.
// A pin on the KEEPING side is the only thing that stops the next reader "fixing" the asymmetry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { suspendMember, reactivateMember } from '../auth/member-suspension.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { deleteTuples } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb

/** Someone with a password AND a factor — the two are separate rows and the whole question is which go. */
async function member(name: string): Promise<string> {
  const sub = `wlocal_f654-${name}-${STAMP}`
  await seatMembers(admin, T, [sub])
  // Rows AND tuples (#471): removal and suspension both take the tenant membership tuple, and a fixture
  // that only has the row makes them refuse a delete of something that was never there.
  await ensureMembers(T, [sub])
  await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
              VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'x') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO member_factors (tenant_id, member_sub, kind, label)
              VALUES (${T}, ${sub}, 'totp', 'phone')`
  return sub
}

const factorCount = async (sub: string): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM member_factors WHERE member_sub = ${sub}`)[0]!.n)

const call = (method: 'POST' | 'DELETE', url: string) =>
  app.inject({ method, url, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM member_factors WHERE member_sub LIKE ${`wlocal_f654-%-${STAMP}`}`.catch(() => {})
  await admin`DELETE FROM local_credentials WHERE member_sub LIKE ${`wlocal_f654-%-${STAMP}`}`.catch(() => {})
  const subs = (await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${T} AND sub LIKE ${`wlocal_f654-%-${STAMP}`}`).map((r) => r.sub)
  if (subs.length) {
    await deleteTuples(fgaClient, memberTuples(T, subs)).catch(() => {})
    await unseatMembers(admin, T, subs).catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#654: the paths that take a credential take the factors with it', () => {
  it('removing the password removes them', async () => {
    const sub = await member('pw')
    expect(await factorCount(sub), 'the fixture has a factor to lose').toBe(1)
    const res = await call('DELETE', `/members/${encodeURIComponent(sub)}/password-setup`)
    expect(res.statusCode, `the removal answered :: ${res.body}`).toBeLessThan(400)
    expect(await factorCount(sub), 'a factor outlived the credential it guarded').toBe(0)
  }, 180_000)

  it('removing the member removes them', async () => {
    const sub = await member('del')
    expect(await factorCount(sub)).toBe(1)
    const res = await call('DELETE', `/members/${encodeURIComponent(sub)}`)
    expect(res.statusCode, `the removal answered :: ${res.body}`).toBeLessThan(400)
    // The concrete reason: subs are reused. A row left here attaches to the next holder of this sub.
    expect(await factorCount(sub), 'a factor outlived its member').toBe(0)
  }, 180_000)
})

describe("#654: SCIM's suspension does NOT — and that is the decision", () => {
  it('a suspended member keeps their factors, and gets them back on reactivation', async () => {
    const sub = await member('scim')
    await suspendMember({ db, fga: fgaClient }, { id: T, plan: 'business' }, sub, { reason: 'scim', actor: 'system' })
    expect(await factorCount(sub), 'suspension is soft: it takes sessions and keys, not enrolments').toBe(1)

    await reactivateMember({ db, fga: fgaClient }, { id: T, plan: 'business' }, sub, { allow: ['scim'], actor: 'system' })
    expect(await factorCount(sub), 'the same person comes back to the same authenticator').toBe(1)
  }, 180_000)
})
