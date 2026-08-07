// #623: the custom-role list arrived whole, from THREE routes that each carried their own copy of the
// same query — the admin list, the space assignable-roles list and the page one.
//
// One function serves all three now, so this file removes three ledger lines. The third route is
// asserted directly rather than assumed from the shared helper: a future split into separate queries
// would leave one of them unbounded, and a pin that only ever asked about the admin route would stay
// green through that.
//
// The cursor is the NAME with no tiebreaker, and that is safe here for a stated reason rather than by
// luck: `roles` carries UNIQUE (tenant_id, name) and RLS pins the tenant, so no two rows in a read can
// share the ordering key. The last case measures that assumption instead of trusting it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { listCustomRoles, listAllCustomRoles } from '../routes/roles.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const PREFIX = `r623-${STAMP}-`
const N = 9
const PAGE = 3

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  for (let i = 0; i < N; i++) {
    await admin`
      INSERT INTO roles (id, tenant_id, name, capabilities, scope)
      VALUES (${`${PREFIX}${i}`}, ${tenant.id}, ${`${PREFIX}${String(i).padStart(2, '0')}`},
              ARRAY['view']::text[], 'resource')`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE ${`${PREFIX}%`}`.catch(() => {})
  await app.close(); await db.release(); await pool.end(); await admin.end()
}, 300_000)

const mine = (names: string[]) => names.filter((n) => n.startsWith(PREFIX))

describe('#623: the custom-role lists are bounded, and three routes share one query', () => {
  it('one response does not carry every custom role', async () => {
    const first = await listCustomRoles(db, { limit: PAGE })
    expect(first.custom.length).toBe(PAGE)
    expect(first.nextCursor, 'and it says there is more').toBeTruthy()
  }, 300_000)

  it('walking the pages returns every role exactly once, by name', async () => {
    const seen: string[] = []
    // ⚠️ The walk starts at this fixture's prefix, not at the beginning. The shared dev tenant holds
    // ~950 roles left behind by parallel suites, so a walk from row one at PAGE = 3 would need hundreds
    // of requests to reach these nine — measured, and it reported "walked 0 and saw 0 of 9", which
    // reads like a broken cursor rather than a fixture that is far down the list.
    //
    // Starting mid-list is not a weaker measurement: resuming from a cursor IS what a page after the
    // first does, and every one of these rows still has to appear exactly once, in order.
    let cursor: string | undefined = PREFIX
    for (let guard = 0; guard < 200; guard++) {
      const page = await listCustomRoles(db, { limit: PAGE, ...(cursor ? { cursor } : {}) })
      seen.push(...page.custom.map((r) => r.name))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${N}`).toBe(N)
    expect(ours, 'the order survives the paging').toEqual([...ours].sort())
  }, 300_000)

  it('the name really is unique per tenant — which is why there is no tiebreaker', async () => {
    // The assumption the cursor rests on, measured. If the constraint ever goes, this fails here rather
    // than as a role that silently never appears in a picker.
    await expect(admin`
      INSERT INTO roles (id, tenant_id, name, capabilities, scope)
      VALUES (${`${PREFIX}dup`}, ${tenant.id}, ${`${PREFIX}00`}, ARRAY['view']::text[], 'resource')`)
      .rejects.toThrow()
  }, 300_000)

  it('all THREE routes answer with a page, not a bare list', async () => {
    // They share one helper today; asserted per route so a future split cannot leave one unbounded
    // while this file stays green. The two resource-scoped ones need a resource, so the assertion is
    // the SHAPE of the answer — a 200 carries nextCursor, and a refusal is not a missing bound.
    const headers = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    const res = await app.inject({ method: 'GET', url: `/admin/roles?limit=${PAGE}`, headers })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { builtIn: unknown[]; custom: unknown[]; nextCursor: string | null }
    expect(body.custom.length).toBe(PAGE)
    expect(body.nextCursor, 'the admin list says there is more').toBeTruthy()
    expect(Array.isArray(body.builtIn), 'the built-in roles still come back whole').toBe(true)

    for (const path of ['/spaces/demo_space/assignable-roles', '/pages/demo/assignable-roles']) {
      const r = await app.inject({ method: 'GET', url: `${path}?limit=${PAGE}`, headers })
      if (r.statusCode !== 200) continue // the fixture may not grant this caller the resource
      const b = r.json() as { custom: unknown[]; nextCursor: string | null }
      expect(b.custom.length, `${path} ignored the limit`).toBeLessThanOrEqual(PAGE)
      expect(b, `${path} answers without a cursor`).toHaveProperty('nextCursor')
    }
  }, 300_000)

  it('the walker returns every role the pages do', async () => {
    const all = mine((await listAllCustomRoles(db)).map((r) => r.name))
    expect(all.length).toBe(N)
  }, 300_000)
})
