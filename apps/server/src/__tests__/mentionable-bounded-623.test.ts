// #623: the @mention autocomplete read the WHOLE roster and then ran an FGA batchCheck over every
// member — the tenant's entire directory, on a keystroke.
//
// The filter moves to the server, which is one of the two shapes this ticket's acceptance names and the
// one `/spaces/:spaceId/member-candidates` already ships. The screen never showed more than five, so
// nothing the reader sees changes.
//
// ⚠️ The OTHER caller of the same helper validates the mentions typed in a comment body, and it must
// stay uncapped: intersecting the typed names with a capped roster silently drops a mention of anyone
// outside it — no notification, no error. The last case is that asymmetry, because a cap applied to
// both would satisfy everything above it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { MENTION_CANDIDATE_SCAN, MENTION_RESULT_LIMIT } from '../routes/comments.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
// ⚠️ Small: `seatMembers` writes rows the seat-cap suites count, and a killed run leaves them behind.
const N = 6
const SUBS = Array.from({ length: N }, (_, i) => `mn623-${STAMP}-${String(i).padStart(2, '0')}`)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let tenant: Tenant, db: TenantDb, app: FastifyInstance
let space: string, pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `mn623-${STAMP}`,
  })).id
  pageId = (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: space, userId: 'dev-user', title: `mn623-page-${STAMP}`, parentId: null,
  })).id
  await seatMembers(admin, tenant.id, SUBS)
  await ensureMembers(tenant.id, SUBS)
  // Distinct display names so the server-side match has something to match ON…
  for (const [i, sub] of SUBS.entries()) {
    await admin`UPDATE members SET display_name = ${`Mn623 ${STAMP} ${i}`} WHERE tenant_id = ${tenant.id} AND sub = ${sub}`
  }
  // …and a DIRECT view grant on the page, or the confirm removes every one of them and the file
  // measures an empty list. Measured that way first: "the matching member is missing".
  await writeTuples(fgaClient, SUBS.map((sub) => ({ user: `user:${sub}`, relation: 'view_direct', object: `page:${pageId}` })))
}, 300_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await deleteTuples(fgaClient, SUBS.map((sub) => ({ user: `user:${sub}`, relation: 'view_direct', object: `page:${pageId}` }))).catch(() => {})
  await deleteTuples(fgaClient, memberTuples(tenant.id, SUBS)).catch(() => {})
  await unseatMembers(admin, tenant.id, SUBS).catch(() => {})
  await app.close(); await app.valkey.quit().catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const ask = (q?: string) =>
  app.inject({
    method: 'GET',
    url: `/pages/${pageId}/mentionable${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    headers: H,
  })

describe('#623: the mention directory is filtered by the server, and bounded', () => {
  it('the answer never exceeds the result limit', async () => {
    const res = await ask()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { members: unknown[] }
    expect(body.members.length).toBeLessThanOrEqual(MENTION_RESULT_LIMIT)
  }, 300_000)

  it('⚠️ the SERVER does the matching — a query narrows the answer', async () => {
    // The half that removes the work: before this, the whole roster crossed the wire and the browser
    // filtered it. A query that matches one member must not come back with the rest.
    const one = await ask(`Mn623 ${STAMP} 3`)
    expect(one.statusCode, one.body).toBe(200)
    const names = (one.json() as { members: { displayName: string | null; sub: string }[] }).members
    expect(names.length, 'the server returned more than the query asked for').toBeLessThanOrEqual(2)
    expect(names.some((m) => m.sub === SUBS[3]), 'the matching member is missing').toBe(true)
    expect(names.some((m) => m.sub === SUBS[0]), 'a non-matching member came back — the filter is not applied')
      .toBe(false)
  }, 300_000)

  it('a query that matches nobody answers empty, not everybody', async () => {
    // The direction a broken filter fails in: an unmatched term falling through to "no WHERE clause"
    // would answer with the whole roster and look like a working autocomplete.
    const none = await ask(`mn623-no-such-person-${STAMP}`)
    expect((none.json() as { members: unknown[] }).members).toEqual([])
  }, 300_000)

  it('the scan is WIDER than the answer — or a page of names yields two', async () => {
    // The confirm removes members who cannot view this page, so taking exactly the result limit from
    // the database would usually answer with a fraction of it. The ceiling on the FGA fan-out is what
    // the ledger line was about, and it is a different number on purpose.
    expect(MENTION_CANDIDATE_SCAN).toBeGreaterThan(MENTION_RESULT_LIMIT)
  }, 300_000)

  it('⚠️ the VALIDATION path is not capped — a mention of anyone at all still lands', async () => {
    // The other caller of this helper intersects the typed names with the roster. Capping it drops a
    // mention of anyone outside the cap — no notification, no error, nothing to notice.
    //
    // Measured through the comment route rather than through a constant: comparing two numbers said
    // nothing, and capping the notify path stayed green until this case existed.
    const target = SUBS[N - 1]!
    const name = `Mn623 ${STAMP} ${N - 1}`.replace(/\s/g, '')
    const res = await app.inject({
      method: 'POST', url: `/pages/${pageId}/comments`, headers: H,
      payload: { body: `hello @${name} please look`, mentions: [target] },
    })
    expect(res.statusCode, res.body).toBe(201)
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications WHERE tenant_id = ${tenant.id} AND member_sub = ${target}`
    expect(row!.n, 'the mention produced no notification — the validation path lost this member').toBeGreaterThan(0)
  }, 300_000)
})
