// #705 v1: the space listing takes a name filter (`q`) — SERVER-side, so a picker's filter hits
// every space the caller may see, not just the page the client happens to hold.
//
// The three properties worth pinning, from the design review:
//   1. AUTHZ: `q` narrows the SQL before the authorization pass — it can only shrink what the
//      caller sees, never widen it. A space the caller cannot view stays invisible however well
//      its name matches (the search-leak boundary, the project design notes's mandatory test).
//   2. COVERAGE: the filter matches spaces beyond the first page of the unfiltered walk — the
//      whole point of moving it server-side.
//   3. CURSOR BINDING (must-fix 5): a cursor minted under one q is refused under another —
//      honouring it would silently return a partial list. The refusal restarts and says so.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'
import { listSpaces, createSpace, deleteSpace } from '../routes/spaces.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
const made: string[] = []
const mk = async (name: string) => {
  const s = await createSpace(db, app.fga, { tenantId: T, userId: OWNER, plan: 'business', name })
  made.push(s.id)
  return s
}

// A member who can see NOTHING this file creates (no space tuples) — the leak probe.
const NOBODY = `f705-nobody-${STAMP}`

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${NOBODY}, ${`${NOBODY}@e2e.test`}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
  await writeTuples(fgaClient, [{ user: `user:${NOBODY}`, relation: 'member', object: `tenant:${T}` }]).catch(() => {})
}, 180_000)

afterAll(async () => {
  for (const id of made) await deleteSpace(db, app.fga, app.searchDriver, { tenantId: T, spaceId: id, userId: OWNER }).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${NOBODY}`, relation: 'member', object: `tenant:${T}` }]).catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${NOBODY}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#705: the server-side name filter', () => {
  it('matches beyond the first unfiltered page (the reason the filter moved server-side)', async () => {
    // Two needles that share a marker no other space carries; the walk between them is long enough
    // that a first-page-only client filter would miss the second one on the dev tenant.
    await mk(`f705 alpha needle ${STAMP}`)
    await mk(`f705 beta needle ${STAMP}`)
    const hit = await listSpaces(db, app.fga, OWNER, { q: `needle ${STAMP}` })
    expect(hit.spaces.map((s) => s.name).sort()).toEqual([
      `f705 alpha needle ${STAMP}`,
      `f705 beta needle ${STAMP}`,
    ])
    // …and an unfiltered FIRST PAGE does not contain them both by accident (premise, not vacuous):
    // the dev tenant carries hundreds of earlier spaces, so a fresh pair lands beyond page one.
    const firstPage = await listSpaces(db, app.fga, OWNER, { limit: 5 })
    const onFirst = firstPage.spaces.filter((s) => s.name.includes(`needle ${STAMP}`)).length
    expect(onFirst, 'the premise: page one alone would not have found both').toBeLessThan(2)
  }, 180_000)

  it('AUTHZ: a matching name the caller cannot view is not returned — q never widens', async () => {
    await mk(`f705 secret needle ${STAMP}`)
    const asNobody = await listSpaces(db, app.fga, NOBODY, { q: `needle ${STAMP}` })
    expect(asNobody.spaces, 'a name match must not defeat the view gate').toEqual([])
    expect(asNobody.nextCursor, 'nor does the walk go on hinting').toBeNull()
  }, 180_000)

  it('CURSOR BINDING: a cursor minted under one q restarts under another, and says so', async () => {
    for (let i = 0; i < 3; i++) await mk(`f705 bind ${i} ${STAMP}`)
    const p1 = await listSpaces(db, app.fga, OWNER, { q: `bind`, limit: 1 })
    expect(p1.nextCursor, 'the premise: the filtered walk has a second page').not.toBeNull()
    // same q → the cursor resumes (no restart flag)
    const p2 = await listSpaces(db, app.fga, OWNER, { q: `bind`, limit: 1, cursor: p1.nextCursor! })
    expect(p2.restarted).toBeUndefined()
    // different q → refused, restarted from the top of THAT walk
    const crossed = await listSpaces(db, app.fga, OWNER, { q: `needle ${STAMP}`, limit: 50, cursor: p1.nextCursor! })
    expect(crossed.restarted, 'a foreign cursor must not silently shorten the list').toBe(true)
    // …and the restart really is the full answer for the new q, not a continuation
    expect(crossed.spaces.some((s) => s.name.includes(`needle ${STAMP}`))).toBe(true)
    // dropping q entirely also refuses a q-minted cursor
    const dropped = await listSpaces(db, app.fga, OWNER, { limit: 1, cursor: p1.nextCursor! })
    expect(dropped.restarted).toBe(true)
  }, 180_000)
})
