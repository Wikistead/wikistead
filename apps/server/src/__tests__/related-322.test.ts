// #322 / ADR-133 §2/§3/§6: the 2-hop "Related" aggregation. Intermediates = pages the target links to;
// related = OTHER pages that also link to a shared intermediate, grouped by that link. The security core is
// the SINGLE-PASS view-filter over BOTH endpoints of every candidate edge — an unviewable related page OR an
// unviewable intermediate makes its node/group vanish (existence-hiding), and count/group/rank run only over
// the filtered set. Members-only (the route omits config.guest). Real Postgres + OpenFGA (+ Fastify for the
// guest-reject route test).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mintGuestToken } from '@wikistead/auth'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, syncPageLinks, getRelatedPages } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []
// P links to M1, M2, M3. Q1→M1,M2 ; Q2→M1 ; Q3hidden→M1 ; Q4→M3.
let P!: string, M1!: string, M2!: string, M3!: string, Q1!: string, Q2!: string, Q3!: string, Q4!: string
const LIMITED = 'user:related-limited-viewer'

async function mk(title: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  ids.push(p.id)
  return p.id
}
async function grantView(subject: string, ...pageIds: string[]) {
  await writeTuples(fgaClient, pageIds.map((id) => ({ user: subject, relation: 'view_direct', object: `page:${id}` })))
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'related-space' })
  spaceId = space.id
  P = await mk('P'); M1 = await mk('M1'); M2 = await mk('M2'); M3 = await mk('M3')
  Q1 = await mk('Q1'); Q2 = await mk('Q2'); Q3 = await mk('Q3hidden'); Q4 = await mk('Q4')
  const edges: [string, string[]][] = [
    [P, [M1, M2, M3]], [Q1, [M1, M2]], [Q2, [M1]], [Q3, [M1]], [Q4, [M3]],
  ]
  for (const [from, tos] of edges) {
    const md = tos.map((t) => `[x](/p/${t})`).join(' ')
    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, from, md))
  }
  // A LIMITED viewer sees P, both first intermediates, and Q1/Q2/Q4 — but NOT the hidden related Q3, nor the
  // intermediate M3. (dev-user, the creator, has manage on all → sees everything.)
  await grantView(LIMITED, P, M1, M2, Q1, Q2, Q4)
}, 90_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
}, 60_000)

describe('getRelatedPages (#322 — 2-hop, both-endpoint view-filter)', () => {
  it('groups related pages by the shared intermediate and ranks by shared-count (creator sees all)', async () => {
    const { groups } = await getRelatedPages(db, fgaClient, { pageId: P, subject: 'user:dev-user' })
    const byMid = new Map(groups.map((g) => [g.intermediate.id, g.pages.map((p) => p.id)]))
    // Scope to THIS test's intermediates — the dev tenant is shared, so other suites' edges may add groups.
    expect(byMid.get(M1)!.slice().sort()).toEqual([Q1, Q2, Q3].slice().sort())
    expect(byMid.get(M2)).toEqual([Q1])
    expect(byMid.get(M3)).toEqual([Q4])
    // Q1 shares TWO of P's intermediates (M1, M2), Q2/Q3 share one → Q1 ranks ABOVE both in the M1 group
    // (shared-intermediate count desc, computed over the view-filtered set).
    const m1 = byMid.get(M1)!
    expect(m1.indexOf(Q1)).toBeLessThan(m1.indexOf(Q2))
    expect(m1.indexOf(Q1)).toBeLessThan(m1.indexOf(Q3))
    // the target P is never its own related page.
    expect(groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain(P)
  })

  it('ANTI-TEST 1: a related page the caller cannot view VANISHES (node-level existence-hiding)', async () => {
    const { groups } = await getRelatedPages(db, fgaClient, { pageId: P, subject: LIMITED })
    const m1 = groups.find((g) => g.intermediate.id === M1)!
    const m1ids = m1.pages.map((p) => p.id)
    expect(m1ids).toContain(Q1)
    expect(m1ids).toContain(Q2)
    expect(m1ids).not.toContain(Q3) // Q3 is un-viewable for LIMITED → absent, not merely hidden in the UI
  })

  it('ANTI-TEST 2: an intermediate the caller cannot view removes its WHOLE group (both-ends filter)', async () => {
    const { groups } = await getRelatedPages(db, fgaClient, { pageId: P, subject: LIMITED })
    // M3 is un-viewable for LIMITED → its group is gone ENTIRELY even though Q4 (its only related page) IS viewable.
    expect(groups.find((g) => g.intermediate.id === M3)).toBeUndefined()
    expect(groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain(Q4)
  })

  it('ANTI-TEST 3: a target the caller cannot view is a uniform 404 (existence-hiding), not a leaked graph', async () => {
    await expect(getRelatedPages(db, fgaClient, { pageId: P, subject: 'user:nobody-here' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET /pages/:id/related route (#322 — members only)', () => {
  let app: FastifyInstance
  let guestTok: string
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
  }, 30_000)
  afterAll(async () => { await app.close() }, 30_000)

  it('a member gets the related result (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/related', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().groups)).toBe(true)
  })

  it('ANTI-TEST 4: a share_link (guest) token is REJECTED — Related is member-only, no live reverse-lookup for a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/related', headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.statusCode).not.toBe(200)
  })
})
