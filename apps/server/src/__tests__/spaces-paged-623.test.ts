// #623 slice 12b: `GET /spaces` stops handing over every space a tenant has.
//
// It had no bound and read as bounded to the ledger, because the only `LIMIT` in the query was a scalar
// sub-select taking the tenant's delete-mode. Measured at 253 rows in one response on the dev tenant, on
// the path the sidebar takes at startup.
//
// What is worth pinning here is NOT "a LIMIT appeared" — the ledger scan already says that, and it says
// it about the source rather than about a response. It is the two things a keyset over an
// authorization-filtered listing gets wrong:
//
//   1. the cursor must come from the last SQL row, not the last VISIBLE one. The filter runs after the
//      query, so a full page can yield zero spaces the caller may see; a cursor taken from the filtered
//      result would be null there and every space after it would be unreachable. That is not a slow
//      walk, it is a silently shorter roster.
//   2. the ORDER BY needs a tiebreaker. Spaces created in one transaction share `created_at` to the
//      microsecond, and without `id` beside it two of them straddle a boundary for ever.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'
import { listSpaces, listAllSpaces, createSpace, deleteSpace, SPACES_PAGE_LIMIT } from '../routes/spaces.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
const made: string[] = []

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  // this file writes rows straight into `spaces`; a run that dies half way leaves them, and the next
  // run measures a tenant with somebody else's litter in it (twice today, on other suites)
  await admin`DELETE FROM spaces WHERE tenant_id = ${T} AND id LIKE 'paged623-%'`.catch(() => {})
}, 180_000)

afterAll(async () => {
  for (const id of made) await deleteSpace(db, app.fga, app.searchDriver, { tenantId: T, spaceId: id, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM spaces WHERE tenant_id = ${T} AND id = ANY(${made})`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#623: the space listing is a page, and the walk reaches the end', () => {
  it('one request carries at most the page limit, and says whether there is more', async () => {
    const first = await listSpaces(db, app.fga, OWNER, { limit: 2 })
    expect(first.spaces.length, 'never more than asked for').toBeLessThanOrEqual(2)
    // the dev tenant has plenty; if it ever did not, this would be vacuous, so assert the premise
    const all = await listAllSpaces(db, app.fga, OWNER)
    expect(all.length, 'the tenant has more spaces than one small page').toBeGreaterThan(2)
    expect(first.nextCursor, 'and the caller is told where to resume').not.toBeNull()
  }, 180_000)

  it('walking the cursor visits every space exactly once', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await listSpaces(db, app.fga, OWNER, { limit: 3, cursor: cursor ?? undefined })
      seen.push(...page.spaces.map((s) => s.id))
      cursor = page.nextCursor
      pages++
      expect(pages, 'the walk terminates').toBeLessThan(500)
    } while (cursor)
    const oneShot = await listAllSpaces(db, app.fga, OWNER)
    expect(new Set(seen).size, 'no space is repeated across pages').toBe(seen.length)
    expect(seen.sort(), 'and the walk sees exactly what the helper does').toEqual(oneShot.map((s) => s.id).sort())
  }, 180_000)

  it('a page whose rows are ALL invisible still hands back a cursor', async () => {
    // The failure this exists for: the caller sees an empty page, concludes the list is over, and never
    // learns about the spaces behind it. Built rather than hoped for.
    // THREE rows, and the page asks for two: without a third there is nothing after the page and
    // `nextCursor` would be null for the honest reason, which would not measure anything.
    const at = new Date()
    const ids = [`paged623-inv1-${STAMP}`, `paged623-inv2-${STAMP}`, `paged623-inv3-${STAMP}`]
    for (const id of ids) {
      // rows only, no FGA tuples — nobody can see them, which is exactly the state a page of
      // other people's spaces has. `createSpace` would grant the creator, and the tenant's
      // creation policy may refuse an arbitrary subject anyway.
      await admin`INSERT INTO spaces (id, tenant_id, name, created_at) VALUES (${id}, ${T}, ${id}, ${at})`
      made.push(id)
    }
    // resume from just before them: the next page is entirely invisible. The cursor is an epoch, so
    // the anchor is written the same way the route writes it.
    const before = ((at.getTime() - 1) / 1000).toFixed(6)
    const page = await listSpaces(db, app.fga, OWNER, { limit: 2, cursor: `${before}|zzzzzzzz` })

    expect(page.spaces, 'the caller may see none of them').toEqual([])
    expect(page.nextCursor, 'and is STILL told where to resume — an empty page is not the end').not.toBeNull()
  }, 180_000)

  it('the ordering carries a tiebreaker, so same-instant spaces cannot straddle a boundary', async () => {
    // WRITTEN TWICE. The first version walked the tie with its own SQL through the admin connection and
    // stayed green with `s.id` deleted from the route's ORDER BY — it was measuring a query it had
    // written itself, which is the shape of vacuous pin this ticket keeps finding. This one walks the
    // SHIPPED listing.
    //
    // The spaces are made through `createSpace` so the caller can actually see them (a row with no FGA
    // tuple is filtered out and the walk has nothing to trip over), then stamped to ONE instant — the
    // state a bulk import leaves, and impossible to produce by calling `createSpace` three times.
    const three = []
    for (const n of ['t1', 't2', 't3']) {
      const sp = await createSpace(db, app.fga, { tenantId: T, plan: 'business', userId: OWNER, name: `paged623-${n}-${STAMP}` })
      made.push(sp.id); three.push(sp.id)
    }
    const at = new Date()
    await admin`UPDATE spaces SET created_at = ${at} WHERE tenant_id = ${T} AND id = ANY(${three})`

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const page = await listSpaces(db, app.fga, OWNER, { limit: 1, cursor: cursor ?? undefined })
      seen.push(...page.spaces.map((sp) => sp.id))
      cursor = page.nextCursor
      expect(guard++, 'the walk terminates').toBeLessThan(1000)
    } while (cursor)

    const hits = three.map((id) => seen.filter((x) => x === id).length)
    expect(hits, 'each of the three same-instant spaces is visited exactly once').toEqual([1, 1, 1])
  }, 300_000)

  it('the route answers with the paged shape', async () => {
    const res = await app.inject({
      method: 'GET', url: '/spaces?limit=1',
      headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json<{ spaces: unknown[]; nextCursor: string | null }>()
    expect(Array.isArray(body.spaces), 'the spaces ride under a key, not as the whole body').toBe(true)
    expect(body.spaces.length).toBeLessThanOrEqual(1)
    expect(body).toHaveProperty('nextCursor')
  }, 180_000)

  it('the default page size is a constant a reader can find', () => {
    // Not decoration: the ledger deletes this route's line because the response is bounded, and the
    // bound has to be a number somebody can change deliberately rather than a literal in a query.
    expect(SPACES_PAGE_LIMIT).toBeGreaterThan(0)
    expect(SPACES_PAGE_LIMIT).toBeLessThanOrEqual(200)
  })
})
