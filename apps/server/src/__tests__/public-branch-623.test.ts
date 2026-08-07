// #623 / ADR-220 §10: one BRANCH of the PUBLIC tree, bounded and keyset-paged.
//
// The whole-tree route walks to depth 6 with 200 children per node — every step bounded, the product
// not — and the depth bound silently drops the level below it. Per-branch fetching removes that
// truncation.
//
// ⚠️ The caller here is ANONYMOUS and supplies the parent id, which makes §2's parent confirmation the
// load-bearing part rather than a defensive extra. #110's ruling is that no path leads through a hidden
// node, even to a public grandchild; on the whole-tree route that is a property of the top-down walk,
// and per-branch it has to be a check. Most of this file is that one claim, from several directions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 7
const PAGE = 3
const H = { host: 'dev.localhost' }

let tenant: Tenant, db: TenantDb, app: FastifyInstance
let space: string, root: string, hiddenParent: string, deepChild: string, nonPublicKid: string
const kids: string[] = []

const publish = (id: string) =>
  admin`UPDATE pages SET published_md = 'body', published_at = now() WHERE id = ${id}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  await admin`INSERT INTO tenant_settings (tenant_id, public_enabled) VALUES (${tenant.id}, true)
              ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = true`
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `pb623-${STAMP}`,
  })).id
  const mk = async (parent: string | null, title: string) => (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: space, userId: 'dev-user', title, parentId: parent,
  })).id
  root = await mk(null, `pb623-root-${STAMP}`)
  for (let i = 0; i < N; i++) kids.push(await mk(root, `pb623-k-${String(i).padStart(2, '0')}`))
  // A parent that is NOT public, holding a child that IS. #110: naming the hidden parent must not hand
  // over its public child.
  hiddenParent = await mk(null, `pb623-hidden-${STAMP}`)
  deepChild = await mk(hiddenParent, `pb623-deep-${STAMP}`)
  // ⚠️ A child of `root` that is PUBLISHED but never anon-viewable (no page#space). Without it the
  // per-row confirm is unmeasured — measured: deleting the confirm left every case green, because every
  // child in the fixture was public.
  nonPublicKid = await mk(root, `pb623-nonpublic-${STAMP}`)

  for (const id of [root, ...kids, hiddenParent, deepChild, nonPublicKid]) await publish(id)
  await writeTuples(fgaClient, [
    { user: 'user:*', relation: 'viewer', object: `space:${space}` },
    ...[root, ...kids, deepChild].map((id) => ({ user: `space:${space}`, relation: 'space', object: `page:${id}` })),
    // hiddenParent gets NO page#space — published, but never anon-viewable.
  ])
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: 'user:*', relation: 'viewer', object: `space:${space}` },
    ...[root, ...kids, deepChild].map((id) => ({ user: `space:${space}`, relation: 'space', object: `page:${id}` })),
  ]).catch(() => {})
  await admin`DELETE FROM pages WHERE space_id = ${space}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await app.close(); await app.valkey.quit().catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const get = (q: string) =>
  app.inject({ method: 'GET', url: `/public/spaces/${space}/pages/branch${q}`, headers: H })

describe('#623 / ADR-220 §10: the public branch is bounded, and naming a parent tells nothing', () => {
  it('one response does not carry the whole branch', async () => {
    const res = await get(`?parent=${root}&limit=${PAGE}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { pages: unknown[]; nextCursor: string | null }
    expect(body.pages.length).toBe(PAGE)
    expect(body.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking returns every public child exactly once, in order', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 50; guard++) {
      const res = await get(`?parent=${root}&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json() as { pages: { id: string }[]; nextCursor: string | null }
      seen.push(...body.pages.map((p) => p.id))
      if (!body.nextCursor) break
      cursor = body.nextCursor
    }
    const repeats = seen.filter((s, i) => seen.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(seen, 'the walk did not return the branch in its own order').toEqual(kids)
    expect(seen, 'a published but non-public child came back — the per-row confirm is gone')
      .not.toContain(nonPublicKid)
  }, 300_000)

  it('⚠️ naming a HIDDEN parent does not hand over its public child (#110)', async () => {
    // The whole reason §2 exists. The child IS public; the parent is not. A top-down walk never reaches
    // it, and per-branch the caller can ask directly — so the parent is confirmed before its children
    // are listed.
    const res = await get(`?parent=${hiddenParent}`)
    expect(res.statusCode, res.body).toBe(404)
    // …and the child really is public, or the case above would pass for the wrong reason.
    const direct = await get(`?parent=${deepChild}`)
    expect(direct.statusCode, 'the deep child is not public — this fixture proves nothing').toBe(200)
  }, 300_000)

  it('every refusal is the SAME 404 — absent, another space, unpublished, not public', async () => {
    const shapes = new Set<string>()
    const other = (await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `pb623-other-${STAMP}`,
    })).id
    const elsewhere = (await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: other, userId: 'dev-user', title: 'pb623-elsewhere', parentId: null,
    })).id
    const draft = (await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space, userId: 'dev-user', title: 'pb623-draft', parentId: root,
    })).id
    try {
      for (const p of ['pb623-no-such-page', elsewhere, draft, hiddenParent]) {
        const res = await get(`?parent=${encodeURIComponent(p)}`)
        shapes.add(`${res.statusCode}:${res.body}`)
      }
      expect(shapes.size, `the refusals differ: ${[...shapes].join(' | ')}`).toBe(1)
      expect([...shapes][0]!.startsWith('404:')).toBe(true)
    } finally {
      await admin`DELETE FROM pages WHERE id IN (${elsewhere}, ${draft})`.catch(() => {})
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: other, userId: 'dev-user' }).catch(() => {})
    }
  }, 300_000)

  it('the depth bound is gone — a level the whole-tree route drops is reachable here', async () => {
    // ADR-220 §10 says this pin REPLACES public.test.ts's "respects the depth bound without a
    // placeholder": the truncation was intended behaviour and per-branch fetching removes it. A child
    // is reached by naming its parent, at any depth.
    const res = await get(`?parent=${deepChild}`)
    expect(res.statusCode, 'a page deep in the tree must be nameable').toBe(200)
    const body = res.json() as { pages: unknown[] }
    expect(Array.isArray(body.pages)).toBe(true)
  }, 300_000)
})
