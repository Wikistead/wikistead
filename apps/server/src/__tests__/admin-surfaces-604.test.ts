// #604 / ADR-208 (ruling B): the carve-out has to be REACHABLE.
//
// The verbs already worked — the routes honoured `manage_connections`, and the review proved
// somebody holding it could call the connections API. They still could not USE it: the console's
// entry was `isAdmin`, so the door was invisible, and the sign-in screen read a tier-gated endpoint
// so it could not draw. This pins the answer the client now renders: the server says which admin
// surfaces are open to the caller, and it says so by walking its own registry.
//
// DISCOVERY, not a table. The cases are generated from ADMIN_SURFACES × TENANT_CAP_RELATION, so a
// verb added later is measured by existing rather than by somebody remembering to add a row here —
// which is exactly the failure this ticket is about (a power that nothing led to).
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { ADMIN_SURFACES, readableAdminSurfaces } from '../routes/admin-surfaces.js'
import { TENANT_CAP_RELATION } from '../routes/roles.js'
import { auditLedgerRegistered } from '../audit/sink.js'
import { analyticsRegistered } from '../analytics/sink.js'

// #692 B: `audit` and `analytics` exist in the registry but only SURFACE when their EE mount
// registered (#688) — the dev suite composes EE through the vitest alias, the CE build composes
// nothing, and a pin that hard-codes the composed answer is red exactly there. The pin asks the same
// predicates production asks, in BOTH directions: registered → the door is offered, not → absent.
const composedSurface = (s: string) =>
  (s !== 'audit' || auditLedgerRegistered()) && (s !== 'analytics' || analyticsRegistered())

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6381')
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const PLAIN = `surf604-plain-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
// A REAL cookie session for a member: the dev-token bypass is `dev-user` (an admin), which cannot
// measure "somebody who is not an admin reaches this".
const session = async (sub: string) => ({
  host: 'dev.localhost',
  cookie: `${SESSION_COOKIE}=${await createSession(valkey, { tenantId: TENANT, sub, role: 'member' })}`,
})

// Every carve-out capability whose relation actually opens a surface. Derived, so the day
// `managePublic` (or anything else) gets a surface, this list grows on its own.
const SURFACE_RELATIONS = new Set(Object.values(ADMIN_SURFACES))
const CARVE_OUTS = (Object.entries(TENANT_CAP_RELATION) as [string, string][])
  .filter(([, relation]) => relation !== 'admin' && SURFACE_RELATIONS.has(relation))

let app: FastifyInstance
const holders = new Map<string, string>() // capability → member sub
const roleIds: string[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  for (const [cap] of CARVE_OUTS) {
    const sub = `surf604-${cap.toLowerCase()}-${STAMP}`
    const res = await app.inject({
      method: 'POST', url: '/admin/roles', headers: H,
      payload: { name: `surf604-${cap}-${STAMP}`, capabilities: [cap], scope: 'tenant' },
    })
    expect(res.statusCode, res.body).toBe(201)
    const roleId = (res.json() as { id: string }).id
    roleIds.push(roleId)
    // #624: a tenant role names somebody who is HERE. This file seats its holders a few lines below
    // (for #471's request-principal rule); the assignment route needs the row FIRST.
    await seatMembers(admin, TENANT, [sub])
    const assign = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H,
      payload: { resourceType: 'tenant', resourceId: TENANT, principal: `user:${sub}` },
    })
    expect(assign.statusCode, assign.body).toBe(201)
    holders.set(cap, sub)
  }
  // #471 / ADR-176: a request principal must be a MEMBER of the tenant. The role assignment confers
  // the verb, not membership — without this the HTTP cases below would refuse for the wrong reason
  // and the pin would pass while measuring nothing.
  await ensureMembers(TENANT, [...holders.values(), PLAIN])
}, 180_000)

afterAll(async () => {
  const { deleteTuples } = await import('@wikistead/authz')
  await deleteTuples(fgaClient, memberTuples(TENANT, [...holders.values(), PLAIN])).catch(() => {})
  for (const sub of holders.values()) await admin`DELETE FROM role_assignments WHERE principal = ${`user:${sub}`}`.catch(() => {})
  for (const id of roleIds) await admin`DELETE FROM roles WHERE id = ${id}`.catch(() => {})
  // and the SEATS. Leaving them behind does not fail this file — it fails whatever measures the tenant's
  // size next: three subs a run pushed `tenant_dev` past the seat cap, so an invite refused with "seat
  // limit reached" (invite-role-582) and a downgrade froze members the fixture expected to survive
  // (plan-freeze). Both were handed on twice as "red on clean master too", which is true and is how a
  // leak keeps its distance from the file that made it.
  await unseatMembers(admin, TENANT, [...holders.values(), PLAIN])
  await app.close(); await admin.end(); await valkey.quit(); await pool.end()
}, 120_000)

describe('#604 a carved-out verb LEADS somewhere', () => {
  it('the registry only names relations that exist as tenant powers', () => {
    // A surface pointing at a relation nothing can grant would be a door with no key — it would
    // silently never open, and no other assertion here would notice.
    const grantable = new Set<string>([...Object.values(TENANT_CAP_RELATION), 'admin'])
    for (const [surface, relation] of Object.entries(ADMIN_SURFACES)) {
      expect(grantable.has(relation), `${surface} is gated by ${relation}, which nothing confers`).toBe(true)
    }
    expect(CARVE_OUTS.length, 'at least one verb opens a surface (else this pin measures nothing)').toBeGreaterThan(0)
  })

  it.each(CARVE_OUTS)('%s opens exactly the surfaces its relation gates — and nothing else', async (cap, relation) => {
    const sub = holders.get(cap)!
    const open = await readableAdminSurfaces(fgaClient, sub, TENANT)
    // #692 B: an uncomposed door is absent for everybody, including its verb's holder.
    const expected = Object.entries(ADMIN_SURFACES)
      .filter(([s, r]) => r === relation && composedSurface(s)).map(([s]) => s)
    expect(open.sort(), `${cap} should open ${expected.join(', ')}`).toEqual(expected.sort())
    // The point of a carve-out: holding one power does not quietly bring the tier's others.
    const tierOnly = Object.entries(ADMIN_SURFACES).filter(([, r]) => r === 'admin').map(([s]) => s)
    for (const surface of tierOnly) expect(open, `${cap} must not open ${surface}`).not.toContain(surface)
  }, 120_000)

  it('a plain member is offered no console at all (the empty answer is what hides the entry)', async () => {
    expect(await readableAdminSurfaces(fgaClient, PLAIN, TENANT)).toEqual([])
  }, 120_000)

  it('an admin still gets every COMPOSED surface — the tier lost nothing', async () => {
    const open = await readableAdminSurfaces(fgaClient, 'dev-user', TENANT)
    expect(open.sort()).toEqual(Object.keys(ADMIN_SURFACES).filter(composedSurface).sort())
    // Both directions of #688's registration signal, so this stays meaningful on BOTH suites:
    // where the EE mount registered, the door must be offered; where it did not, offering it
    // would be dead navigation (the exact defect readableAdminSurfaces filters against).
    expect(open.includes('audit'), 'audit door disagrees with auditLedgerRegistered()').toBe(auditLedgerRegistered())
    expect(open.includes('analytics'), 'analytics door disagrees with analyticsRegistered()').toBe(analyticsRegistered())
  }, 120_000)

  it('the endpoint answers the CALLER\'s own list, and needs no tier to be asked', async () => {
    // Gating this route on `admin` would rebuild the hole: a verb holder could not ask whether their
    // verb opens anything, so the client would be back to guessing from a tier flag.
    const [cap] = CARVE_OUTS[0]!
    const sub = holders.get(cap)!
    const res = await app.inject({ method: 'GET', url: '/admin/surfaces', headers: await session(sub) })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { surfaces: string[] }).surfaces).toEqual(await readableAdminSurfaces(fgaClient, sub, TENANT))
  }, 120_000)
})

describe('#604 the sign-in screen stands up for a connection manager', () => {
  it('its READ answers the verb holder, and tells them the stance is not theirs to write', async () => {
    const sub = holders.get('manageConnections')!
    const res = await app.inject({ method: 'GET', url: '/admin/login-methods', headers: await session(sub) })
    // Before this change the screen read a tier-gated endpoint, so a verb holder got a 403 and a
    // blank page while their own connections API answered 200 — the review symptom exactly.
    expect(res.statusCode, res.body).toBe(200)
    const view = res.json() as { canManageStance: boolean; methods: Record<string, unknown> }
    expect(view.methods, 'the method list is what makes their connections legible').toBeTruthy()
    // The WRITE line did not move: the stance decides who can get in at all (#605 break-glass), so
    // it stays with the tier — and the screen is TOLD, instead of inferring it from a tier flag.
    expect(view.canManageStance).toBe(false)
  }, 120_000)

  it('an admin reads the same screen and is told the stance IS theirs', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login-methods', headers: H })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { canManageStance: boolean }).canManageStance).toBe(true)
  }, 120_000)

  it('the stance WRITE still refuses the verb holder (the carve-out did not widen)', async () => {
    const sub = holders.get('manageConnections')!
    const res = await app.inject({
      method: 'PATCH', url: '/admin/login-methods',
      headers: { ...(await session(sub)), 'content-type': 'application/json' },
      payload: { platformLoginEnabled: false },
    })
    expect(res.statusCode).toBe(403)
  }, 120_000)

  it('and the surfaces their verb does not open stay refused (no tier by the back door)', async () => {
    const sub = holders.get('manageConnections')!
    const h = await session(sub)
    expect((await app.inject({ method: 'GET', url: '/admin/roles', headers: h })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/members', headers: h })).statusCode).toBe(403)
  }, 120_000)
})
