// #394 / ADR-147 (ADR-133 §6 increment ③a): the local link graph. depth=1 returns the edges touching the
// center; depth=2 adds edges touching a 1-hop neighbour (including edges AMONG neighbours). The security
// core is the same both-endpoint view-filter as getRelatedPages: an edge appears ONLY when the caller can
// view BOTH endpoints, an unviewable page is absent as a NODE (no dangling edge / title leak), and a page
// reachable only THROUGH an unviewable page vanishes with it. The node cap runs post-filter and over-cap is
// reported via hiddenCount. Members-only (the route omits config.guest). Real Postgres + OpenFGA.
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
import { createPage, deletePage, syncPageLinks, getLocalGraph } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []
// P→A, P→B, C→P, H→P (H is hidden from LIMITED), A→B (edge among neighbours), B→D (2-hop), H→E (E is
// viewable but reachable ONLY through hidden H). X1..X26 →P pad the depth-1 neighbourhood past the 30 cap.
let P!: string, A!: string, B!: string, C!: string, D!: string, E!: string, H!: string, ISO!: string
const LIMITED = 'user:graph-limited-viewer'

async function mk(title: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  ids.push(p.id)
  return p.id
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'local-graph-space' })
  spaceId = space.id
  P = await mk('P'); A = await mk('A'); B = await mk('B'); C = await mk('C')
  D = await mk('D'); E = await mk('E'); H = await mk('Hhidden'); ISO = await mk('Isolated')
  const xs: string[] = []
  for (let i = 1; i <= 26; i++) xs.push(await mk(`X${i}`))
  const edges: [string, string[]][] = [
    [P, [A, B]], [C, [P]], [H, [P, E]], [A, [B]], [B, [D]],
    ...xs.map((x): [string, string[]] => [x, [P]]),
  ]
  for (const [from, tos] of edges) {
    const md = tos.map((t) => `[x](/p/${t})`).join(' ')
    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, from, md))
  }
  // LIMITED sees everything EXCEPT H (and the X pad pages — they only matter for the creator's cap test).
  await writeTuples(fgaClient, [P, A, B, C, D, E].map((id) => ({ user: LIMITED, relation: 'view_direct', object: `page:${id}` })))
}, 120_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
}, 60_000)

const edgeKeys = (r: { edges: { from: string; to: string }[] }) => r.edges.map((e) => `${e.from}>${e.to}`)
const nodeIds = (r: { nodes: { id: string }[] }) => r.nodes.map((n) => n.id)

describe('getLocalGraph (#394 — neighbourhood shape)', () => {
  it('depth=1 returns only edges touching the center; neighbour-to-neighbour edges wait for depth=2', async () => {
    const g = await getLocalGraph(db, fgaClient, { pageId: P, depth: 1, subject: LIMITED })
    expect(g.center).toBe(P)
    expect(edgeKeys(g)).toEqual(expect.arrayContaining([`${P}>${A}`, `${P}>${B}`, `${C}>${P}`]))
    expect(edgeKeys(g)).not.toContain(`${A}>${B}`) // among neighbours — not touching P
    expect(nodeIds(g)).not.toContain(D) // 2-hop node absent at depth 1
    // every returned node carries its title (the renderer never fetches per-node)
    expect(g.nodes.find((n) => n.id === A)?.title).toBe('A')
  })

  it('depth=2 adds edges among/from neighbours (A→B, B→D)', async () => {
    const g = await getLocalGraph(db, fgaClient, { pageId: P, depth: 2, subject: LIMITED })
    expect(edgeKeys(g)).toEqual(expect.arrayContaining([`${A}>${B}`, `${B}>${D}`]))
    expect(nodeIds(g)).toContain(D)
  })

  it('an isolated page still returns its center node (no edges)', async () => {
    const g = await getLocalGraph(db, fgaClient, { pageId: ISO, depth: 1, subject: 'user:dev-user' })
    expect(g.edges.filter((e) => e.from === ISO || e.to === ISO)).toEqual([])
    expect(nodeIds(g)).toContain(ISO)
    expect(g.nodes.find((n) => n.id === ISO)?.title).toBe('Isolated')
  })
})

describe('getLocalGraph (#394 — authz anti-tests, both-endpoint view-filter)', () => {
  it('ANTI-TEST 1: an unviewable page is absent as a NODE — its edges vanish with it (no dangling edge)', async () => {
    const g1 = await getLocalGraph(db, fgaClient, { pageId: P, depth: 1, subject: LIMITED })
    expect(nodeIds(g1)).not.toContain(H)
    expect(edgeKeys(g1)).not.toContain(`${H}>${P}`)
    expect(g1.nodes.map((n) => n.title)).not.toContain('Hhidden') // never a title leak
  })

  it('ANTI-TEST 2: a page reachable ONLY through an unviewable page vanishes with it (E via hidden H)', async () => {
    const g2 = await getLocalGraph(db, fgaClient, { pageId: P, depth: 2, subject: LIMITED })
    expect(nodeIds(g2)).not.toContain(H)
    expect(nodeIds(g2)).not.toContain(E) // E is viewable, but its only edge H→E has a hidden endpoint
    expect(edgeKeys(g2)).not.toContain(`${H}>${E}`)
  })

  it('ANTI-TEST 3: the creator DOES see H and E (the filter is per-viewer, not global)', async () => {
    const g = await getLocalGraph(db, fgaClient, { pageId: P, depth: 2, subject: 'user:dev-user' })
    expect(nodeIds(g)).toEqual(expect.arrayContaining([H, E]))
    expect(edgeKeys(g)).toEqual(expect.arrayContaining([`${H}>${P}`, `${H}>${E}`]))
  })

  it('ANTI-TEST 4: an unviewable center is a uniform 404 (existence-hiding), never an empty graph', async () => {
    await expect(getLocalGraph(db, fgaClient, { pageId: P, depth: 1, subject: 'user:nobody-here' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('getLocalGraph (#394 — post-filter node cap)', () => {
  it('caps nodes at 30 for depth=1, keeps the center, and REPORTS the drop via hiddenCount', async () => {
    // Creator sees all of P's depth-1 neighbourhood: P + A,B,C,H + X1..X26 = 31 viewable nodes > 30 cap.
    const g = await getLocalGraph(db, fgaClient, { pageId: P, depth: 1, subject: 'user:dev-user' })
    expect(g.nodes.length).toBe(30)
    expect(g.hiddenCount).toBe(1)
    expect(nodeIds(g)).toContain(P)
    // no dangling edge after the cap: every edge endpoint is a returned node
    const kept = new Set(nodeIds(g))
    for (const e of g.edges) {
      expect(kept.has(e.from)).toBe(true)
      expect(kept.has(e.to)).toBe(true)
    }
  })

  it('the cap runs AFTER the view-filter: for LIMITED (7 viewable nodes) nothing is hidden', async () => {
    const g = await getLocalGraph(db, fgaClient, { pageId: P, depth: 1, subject: LIMITED })
    expect(g.hiddenCount).toBe(0)
    expect(g.nodes.length).toBeLessThan(30)
  })
})

describe('GET /pages/:id/graph route (#394 — members only)', () => {
  let app: FastifyInstance
  let guestTok: string
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
  }, 30_000)
  afterAll(async () => { await app.close() }, 30_000)

  it('a member gets the graph (200), depth defaults to 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/graph', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.nodes)).toBe(true)
    expect(Array.isArray(body.edges)).toBe(true)
  })

  it('ANTI-TEST 5: a share_link (guest) token is REJECTED — the graph is member-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/graph?depth=2', headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.statusCode).not.toBe(200)
  })
})
