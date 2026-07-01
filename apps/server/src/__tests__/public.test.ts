// Integration tests — real Postgres + real OpenFGA, no mocks.
// Prerequisites: docker compose up -d && pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Y from 'yjs'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { loadPublicChildTree, type PublicChild } from '../routes/public.js'
import { checkRelation } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

// The anonymous principal used for all public checks.
// user:anonymous has NO relationships — can only access pages via user:* wildcard.
const ANON = 'user:anonymous'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
let publicPageId: string
let privatePageId: string

// Seed a ydoc with known content for the public page
function makeYdoc(text: string): Buffer {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)

  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'public-test-space',
  })
  spaceId = space.id

  // Public page: will have page:X#view@user:* tuple
  const pub = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Public Page',
  })
  publicPageId = pub.id
  await adminPool`UPDATE pages SET ydoc = ${makeYdoc('hello public world')} WHERE id = ${publicPageId}`

  // Write the public tuple
  await writeTuples(fgaClient, [
    { user: 'user:*', relation: 'view_base', object: `page:${publicPageId}` },
  ])

  // Private page: no user:* tuple
  const priv = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Private Page',
  })
  privatePageId = priv.id
})

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${publicPageId}` }])
  await deletePage(db, fgaClient, driver, { pageId: publicPageId, userId: 'dev-user' })
  await deletePage(db, fgaClient, driver, { pageId: privatePageId, userId: 'dev-user' })
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
  await adminPool.end()
})

// ── user:anonymous principal ──────────────────────────────────────────────

describe('user:anonymous principal semantics', () => {
  it('user:anonymous can view a page with user:* grant (via FGA check)', async () => {
    const ok = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: publicPageId })
    expect(ok).toBe(true)
  })

  it('user:anonymous cannot view a private page (no user:* grant)', async () => {
    const ok = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: privatePageId })
    expect(ok).toBe(false)
  })

  it('user:anonymous cannot view private page even after deleting public grant (revocation)', async () => {
    // Write, verify true, delete, verify false
    const pageId = publicPageId  // already has grant; test deletion
    await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${pageId}` }])
    expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: pageId })).toBe(false)

    // Restore for subsequent tests
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${pageId}` }])
    expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: pageId })).toBe(true)
  })
})

// ── loadPublicPage (service-level test via DB) ────────────────────────────

describe('public page rendering', () => {
  it('returns correct content for a public page', async () => {
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: publicPageId })
    expect(isPublic).toBe(true)

    // Read page under RLS (tenant_dev context)
    const page = await pool.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
      const [r] = await tx<{ id: string; title: string; ydoc: Buffer | null; noindex: boolean }[]>`
        SELECT id, title, ydoc, noindex FROM pages WHERE id = ${publicPageId}
      `
      return r ?? null
    }) as { id: string; title: string; ydoc: Buffer | null; noindex: boolean } | null

    expect(page).not.toBeNull()
    expect(page!.title).toBe('Public Page')
    expect(page!.noindex).toBe(false)

    // Decode Y.Text content
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(page!.ydoc!))
    expect(doc.getText('content').toString()).toBe('hello public world')
  })

  it('private page check returns false (not 403, no info leakage about existence)', async () => {
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: privatePageId })
    expect(isPublic).toBe(false)
    // Caller should return 404, not 403, to avoid leaking that the page exists
  })

  it('tenant RLS is active even for public pages (cross-tenant page returns null)', async () => {
    // Insert an acme page with a public tuple
    const [{ id: acmeSpaceId }] = await adminPool<[{ id: string }]>`
      INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'public-test-acme-space') RETURNING id
    `
    const [{ id: acmePageId }] = await adminPool<[{ id: string }]>`
      INSERT INTO pages (tenant_id, space_id, title)
      VALUES ('tenant_acme', ${acmeSpaceId}, 'Acme Public Page') RETURNING id
    `
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${acmePageId}` }])

    try {
      // FGA says the acme page is public (user:anonymous can view it)
      expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: acmePageId })).toBe(true)

      // But reading it under tenant_dev RLS returns null (tenant isolation holds)
      const row = await pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        const [r] = await tx`SELECT id FROM pages WHERE id = ${acmePageId}`
        return r ?? null
      }) as unknown as null

      expect(row).toBeNull()
    } finally {
      await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${acmePageId}` }])
      await adminPool`DELETE FROM spaces WHERE id = ${acmeSpaceId}`
    }
  })
})

// ── listObjects with user:anonymous ──────────────────────────────────────

describe('listObjects for public pages', () => {
  it('lists public pages via user:anonymous (consistent with single check)', async () => {
    const { objects } = await fgaClient.listObjects({
      user: ANON,
      relation: 'view',
      type: 'page',
    })
    const ids = (objects ?? []).map((o: string) => o.replace(/^page:/, ''))
    expect(ids).toContain(publicPageId)
    expect(ids).not.toContain(privatePageId)
  })
})

// ── noindex field ─────────────────────────────────────────────────────────

describe('noindex', () => {
  it('noindex defaults to false', async () => {
    const [row] = await adminPool<[{ noindex: boolean }]>`SELECT noindex FROM pages WHERE id = ${publicPageId}`
    expect(row.noindex).toBe(false)
  })

  it('noindex=true is reflected in the page response', async () => {
    await adminPool`UPDATE pages SET noindex = true WHERE id = ${publicPageId}`
    const [row] = await adminPool<[{ noindex: boolean }]>`SELECT noindex FROM pages WHERE id = ${publicPageId}`
    expect(row.noindex).toBe(true)
    // noindex enforcement (X-Robots-Tag, <meta>) is the HTML rendering layer's
    // responsibility — tested here only as field presence.
    await adminPool`UPDATE pages SET noindex = false WHERE id = ${publicPageId}`
  })
})

// ── loadPublicChildTree (ADR-030 / #26): leak-safe public descendant tree ──
//
// Authz-critical (per the approval on #110): a public parent must NOT make its children
// public, and a non-public node must leave NO observable trace — not by id/title/count, NOR
// by a gap/index/ordering/size. "Public" means ANON (user:anonymous) can `view`; a share-link
// child (viewable only by share_link:Y, not user:*) is NOT public and stays hidden. The
// fixture (sibling order = creation order via append):
//
//   P (public)
//   ├─ C1 (public)            → shown
//   │   ├─ G1 (public)        → shown (recursion into a public node)
//   │   └─ G3 (PRIVATE)       → hidden (non-public grandchild under a *public* parent)
//   ├─ Cmid (PRIVATE)         → hidden (sits between two public siblings — gap not revealed)
//   ├─ Cpub2 (public)         → shown (proves order compacts: [C1, Cpub2], no slot for Cmid)
//   ├─ Cshare (share-only)    → hidden for ANON (viewable only via share_link:tl)
//   └─ C2 (PRIVATE)           → hidden
//       └─ G2 (public)        → hidden (only reachable through private C2 — never traversed)
describe('loadPublicChildTree leak safety', () => {
  let P: string, C1: string, Cmid: string, Cpub2: string, Cshare: string, C2: string
  let G1: string, G3: string, G2: string
  const SHARE = 'share_link:tl'

  // Flatten every id that appears anywhere in the returned tree.
  function flatten(nodes: PublicChild[]): string[] {
    return nodes.flatMap((n) => [n.id, ...flatten(n.children)])
  }

  beforeAll(async () => {
    const mk = async (title: string, parentId: string | null) =>
      (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })).id
    P = await mk('P public parent', null)
    // direct children, created in this order so positions are C1 < Cmid < Cpub2 < Cshare < C2
    C1 = await mk('C1 public child', P)
    Cmid = await mk('Cmid private child', P)
    Cpub2 = await mk('Cpub2 public child', P)
    Cshare = await mk('Cshare share-only child', P)
    C2 = await mk('C2 private child', P)
    G1 = await mk('G1 public grandchild', C1)
    G3 = await mk('G3 private grandchild', C1)
    G2 = await mk('G2 public-but-under-private', C2)

    // Public (user:*) grants: P, C1, Cpub2, G1, G2. NOT Cmid/G3/C2 (no grant) and NOT
    // Cshare (share-link only). G2 is granted public on its own, yet must stay hidden because
    // the only path to it runs through the private C2.
    await writeTuples(fgaClient, [P, C1, Cpub2, G1, G2].map((id) => ({ user: 'user:*', relation: 'view_base', object: `page:${id}` })))
    // Cshare is genuinely viewable — but only by a share_link principal, never by ANON.
    await writeTuples(fgaClient, [{ user: SHARE, relation: 'view_base', object: `page:${Cshare}` }])
  })

  afterAll(async () => {
    await deleteTuples(fgaClient, [P, C1, Cpub2, G1, G2].map((id) => ({ user: 'user:*', relation: 'view_base', object: `page:${id}` })))
    await deleteTuples(fgaClient, [{ user: SHARE, relation: 'view_base', object: `page:${Cshare}` }])
    // delete leaves first (children before parents) so the parent_id tree stays consistent
    for (const id of [G1, G3, G2, C1, Cmid, Cpub2, Cshare, C2, P]) {
      await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    }
  })

  it('includes public direct children and recurses into a public child', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    expect(tree.map((n) => n.id)).toContain(C1)
    expect(tree.map((n) => n.id)).toContain(Cpub2)
    const c1 = tree.find((n) => n.id === C1)!
    expect(c1.children.map((n) => n.id)).toContain(G1) // recursion into a public node
  })

  it('① excludes a non-public direct child (no id, no title, no placeholder)', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    expect(flatten(tree)).not.toContain(Cmid)
    expect(flatten(tree)).not.toContain(C2)
    expect(JSON.stringify(tree)).not.toContain('private') // private titles never leak
  })

  it('② excludes a non-public grandchild under a PUBLIC parent (no inheritance at any depth)', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    const c1 = tree.find((n) => n.id === C1)!
    expect(c1.children.map((n) => n.id)).not.toContain(G3) // G3 checked individually, excluded
  })

  it('③ excludes a share-only child (public = ANON view, not share_link)', async () => {
    // Sanity: Cshare really is viewable — just not by ANON. Proves it is a genuine share-only
    // page, not merely an ungranted one, and that we key on ANON view specifically.
    expect(await checkRelation(fgaClient, SHARE, 'view', { type: 'page', id: Cshare })).toBe(true)
    expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: Cshare })).toBe(false)
    const tree = await loadPublicChildTree(tenant.id, P)
    expect(flatten(tree)).not.toContain(Cshare)
  })

  it('④ compacts order so a hidden sibling leaves no gap/index/placeholder', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    // Exactly the public siblings, in order, with NO slot for Cmid/Cshare/C2 between them.
    expect(tree.map((n) => n.id)).toEqual([C1, Cpub2])
    // No positional / index field leaks the original sibling slots.
    for (const n of tree) expect(Object.keys(n).sort()).toEqual(['children', 'id', 'title'])
  })

  it('does NOT traverse through a private node, even to a public grandchild', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    expect(flatten(tree)).not.toContain(G2) // public on its own, but unreachable via private C2
  })

  it('returns only confirmed-public nodes (no foreign id leaks anywhere)', async () => {
    const tree = await loadPublicChildTree(tenant.id, P)
    const allowed = new Set([C1, Cpub2, G1]) // everything reachable through public nodes only
    for (const id of flatten(tree)) expect(allowed.has(id)).toBe(true)
  })

  it('⑤ respects the depth bound without a placeholder for the cut-off subtree', async () => {
    const shallow = await loadPublicChildTree(tenant.id, P, 1) // direct children only
    const c1 = shallow.find((n) => n.id === C1)!
    expect(c1.children).toEqual([]) // G1/G3 are depth 2 — empty array, not a hint they exist
  })
})
