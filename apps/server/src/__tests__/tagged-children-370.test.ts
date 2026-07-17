// #370 / ADR-145: frontmatter tags + the `:::tagged` / `:::children` dynamic lists (they replace ADR-134's
// `:::query`). Every read is view-filtered and existence-hiding (the search-leak class): the host page is
// view-gated (uniform 404), every result is FGA-view-confirmed (absent from list AND count), published-only,
// member-live only (guest 401; the public/guest surface renders the baked ANONYMOUS snapshot). page_tags is a
// stage-1 candidate set only. Real Postgres + OpenFGA (+ Fastify for the guest-reject route test).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { mintGuestToken } from '@wikistead/auth'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import {
  createPage, deletePage, getPublished, getListResults, parseTaggedBody, parseFrontmatterBlock,
  extractFrontmatterTags, syncPageTags, resolveAnonymousListSnapshot, bakeListSnapshot,
  substituteListSnapshots, type ListSnapshot,
} from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []
let parent!: string
let childPub1!: string
let childPub2!: string
let childDraft!: string // a child that is NOT published — absent from the published graph
let hub!: string        // the page hosting the :::tagged directive
let recipeA!: string    // published, tagged "Recipes"
let recipeB!: string    // published, tagged "recipes" (different casing — same tag, user ruling)
let recipeDraft!: string // tagged in its draft text but never published → never in page_tags

// Create a page; when `md` is given, mark it published AND sync the tag projection from it (the raw UPDATE
// shortcut skips publishPage, so the projection sync is done here exactly as the publish tx would).
async function mkPage(title: string, md: string | null, parentId?: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  ids.push(p.id)
  if (md !== null) {
    await adminPool`UPDATE pages SET published_md = ${md}, published_at = now() WHERE id = ${p.id}`
    await db.tx(async (tx) => syncPageTags(tx, tenant.id, p.id, md))
  }
  return p.id
}

const fm = (tags: string) => `---\ntags: ${tags}\n---\n\nbody\n`

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'tagged-space' })
  spaceId = space.id
  parent = await mkPage('Parent', 'parent body')
  childPub1 = await mkPage('Child One', 'c1', parent)
  childPub2 = await mkPage('Child Two', 'c2', parent)
  childDraft = await mkPage('Child Draft', null, parent) // never published
  hub = await mkPage('Recipe Hub', 'hub body')
  recipeA = await mkPage('Carbonara', fm('[Recipes, dinner]'))
  recipeB = await mkPage('Miso Soup', fm('[recipes]'))
  recipeDraft = await mkPage('Draft Stew', null) // draft — its text may carry tags but is never projected
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('frontmatter parsing (#370 — minimal YAML subset, pure)', () => {
  it('parses the leading fence bounds and inner text', () => {
    const b = parseFrontmatterBlock('---\ntags: [a]\n---\nbody')
    expect(b).not.toBeNull()
    expect(b!.from).toBe(0)
    expect(b!.inner).toBe('tags: [a]')
    expect('---\ntags: [a]\n---\nbody'.slice(b!.from, b!.to)).toBe('---\ntags: [a]\n---')
  })

  it('is position-0-only: a fence later in the document is NOT frontmatter', () => {
    expect(parseFrontmatterBlock('intro\n---\ntags: [a]\n---\n')).toBeNull()
  })

  it('an unterminated fence is not frontmatter (a lone --- is a thematic break)', () => {
    expect(parseFrontmatterBlock('---\ntags: [a]\nbody')).toBeNull()
  })

  it('extracts inline-array, dash-list, and single-scalar tags; quotes stripped', () => {
    expect(extractFrontmatterTags('---\ntags: [a, "b c", \'d\']\n---\n')).toEqual([
      { tag: 'a', display: 'a' }, { tag: 'b c', display: 'b c' }, { tag: 'd', display: 'd' },
    ])
    expect(extractFrontmatterTags('---\ntags:\n  - one\n  - two\n---\n')).toEqual([
      { tag: 'one', display: 'one' }, { tag: 'two', display: 'two' },
    ])
    expect(extractFrontmatterTags('---\ntags: solo\n---\n')).toEqual([{ tag: 'solo', display: 'solo' }])
  })

  it('tags are case-insensitively identical: the key lowercases, the display keeps the first casing', () => {
    expect(extractFrontmatterTags('---\ntags: [Recipes, recipes, RECIPES]\n---\n')).toEqual([
      { tag: 'recipes', display: 'Recipes' },
    ])
  })

  it('no frontmatter / no tags field / garbage → no tags, never an error', () => {
    expect(extractFrontmatterTags('# just a doc')).toEqual([])
    expect(extractFrontmatterTags('---\ntitle: x\n---\n')).toEqual([])
    expect(extractFrontmatterTags('---\ntags: []\n---\n')).toEqual([])
  })

  it('parseTaggedBody: first non-empty line, lowercased; empty body → null', () => {
    expect(parseTaggedBody('\n  Recipes  \n')).toBe('recipes')
    expect(parseTaggedBody('')).toBeNull()
  })
})

describe('getListResults tagged (#370 / ADR-145 §4)', () => {
  it('lists the PUBLISHED pages carrying the tag, case-insensitively, with titles', async () => {
    const rows = await getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: 'RECIPES', subject: 'user:dev-user' })
    const found = rows.map((r) => r.id)
    expect(found).toContain(recipeA)
    expect(found).toContain(recipeB)
    expect(found).not.toContain(recipeDraft) // draft → never projected → absent until publish
    expect(rows.find((r) => r.id === recipeA)?.title).toBe('Carbonara')
  })

  it('the HOST page itself is excluded (a tagged hub never lists itself)', async () => {
    const rows = await getListResults(db, fgaClient, { pageId: recipeA, name: 'tagged', body: 'recipes', subject: 'user:dev-user' })
    expect(rows.map((r) => r.id)).not.toContain(recipeA)
    expect(rows.map((r) => r.id)).toContain(recipeB)
  })

  it('AUTHZ: an unviewable HOST page is a uniform 404 (existence-hiding), not a list', async () => {
    await expect(getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: 'recipes', subject: 'user:other-member' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('AUTHZ: a tagged page the caller cannot view is ABSENT from list AND count (omit-on-deny)', async () => {
    // Grant limited-t view on the hub + recipeA only; recipeB (same tag) stays unviewable.
    const grants = [
      { user: 'user:limited-t', relation: 'view_direct', object: `page:${hub}` },
      { user: 'user:limited-t', relation: 'view_direct', object: `page:${recipeA}` },
    ]
    await writeTuples(fgaClient, grants)
    try {
      const rows = await getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: 'recipes', subject: 'user:limited-t' })
      const found = rows.map((r) => r.id)
      expect(found).toContain(recipeA)
      expect(found).not.toContain(recipeB) // absent, not merely hidden — and the count is 1, not 2
      expect(rows.map((r) => r.title)).not.toContain('Miso Soup')
    } finally {
      await deleteTuples(fgaClient, grants).catch(() => {})
    }
  })

  it('an empty/blank tag body yields an empty list (never an error)', async () => {
    expect(await getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: '  \n ', subject: 'user:dev-user' })).toEqual([])
  })

  it('unpublish clears the projection: syncPageTags(md=null) removes the rows', async () => {
    const tmp = await mkPage('Tmp Tagged', fm('[tmporary]'))
    expect((await getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: 'tmporary', subject: 'user:dev-user' })).map((r) => r.id)).toContain(tmp)
    await db.tx(async (tx) => syncPageTags(tx, tenant.id, tmp, null))
    expect(await getListResults(db, fgaClient, { pageId: hub, name: 'tagged', body: 'tmporary', subject: 'user:dev-user' })).toEqual([])
  })
})

describe('getListResults children (#370 — the DESCENDANT TREE, depth-annotated + re-rooted)', () => {
  let grandUnderC1!: string  // published grandchild (parent > childPub1 > grandUnderC1)
  let grandUnderC2!: string  // published grandchild (parent > childPub2 > grandUnderC2) — the re-root probe
  let underDraft!: string    // published child of the UNPUBLISHED childDraft — re-roots past the draft

  beforeAll(async () => {
    grandUnderC1 = await mkPage('Grand One', 'g1', childPub1)
    grandUnderC2 = await mkPage('Grand Two', 'g2', childPub2)
    underDraft = await mkPage('Under Draft', 'ud', childDraft)
  }, 60_000)

  it('returns the descendant TREE pre-order with depth: children at 0, grandchildren nested at 1', async () => {
    const rows = await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:dev-user' })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(childPub1)?.depth).toBe(0)
    expect(byId.get(childPub2)?.depth).toBe(0)
    expect(byId.get(grandUnderC1)?.depth).toBe(1) // the headline: grandchildren ARE in the list, nested
    expect(byId.get(grandUnderC2)?.depth).toBe(1)
    // pre-order: a grandchild follows ITS parent, before the next sibling subtree
    const order = rows.map((r) => r.id)
    expect(order.indexOf(grandUnderC1)).toBeGreaterThan(order.indexOf(childPub1))
    expect(order.indexOf(grandUnderC1)).toBeLessThan(order.indexOf(childPub2))
  })

  it('an UNPUBLISHED intermediate never appears, but its published descendants RE-ROOT to this level', async () => {
    const rows = await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:dev-user' })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has(childDraft)).toBe(false)          // draft → absent (published graph)
    expect(byId.get(underDraft)?.depth).toBe(0)       // its published child surfaces, re-rooted to the top level
  })

  it('AUTHZ: a caller who CANNOT view the parent gets a uniform 404, and a non-existent id the SAME 404', async () => {
    await expect(getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:other-member' }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(getListResults(db, fgaClient, { pageId: 'no-such-page', name: 'children', body: '', subject: 'user:dev-user' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('AUTHZ: an unviewable NODE is absent at every depth (no title/count leak) — a deep grandchild too', async () => {
    const grants = [
      { user: 'user:member-b', relation: 'view_direct', object: `page:${parent}` },
      { user: 'user:member-b', relation: 'restricted', object: `page:${childPub2}` },
      { user: 'user:member-b', relation: 'restricted', object: `page:${grandUnderC1}` },
      { user: 'user:member-b', relation: 'restricted', object: `page:${grandUnderC2}` },
      { user: 'user:*', relation: 'published', object: `page:${childPub1}` },
      { user: 'user:*', relation: 'published', object: `page:${childPub2}` },
      { user: 'user:*', relation: 'published', object: `page:${grandUnderC1}` },
      { user: 'user:*', relation: 'published', object: `page:${grandUnderC2}` },
    ]
    await writeTuples(fgaClient, grants)
    try {
      const rows = await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:member-b' })
      const found = rows.map((r) => r.id)
      expect(found).toContain(childPub1)
      expect(found).not.toContain(childPub2)     // unviewable direct child — absent
      expect(found).not.toContain(grandUnderC1)  // unviewable GRANDchild — absent at depth too
      expect(found).not.toContain(grandUnderC2)
      expect(rows.map((r) => r.title)).not.toContain('Child Two')
    } finally {
      await deleteTuples(fgaClient, grants).catch(() => {})
    }
  })

  it('AUTHZ: an unviewable INTERMEDIATE drops out but its viewable descendants RE-ROOT (GuestSidebar pattern)', async () => {
    const grants = [
      { user: 'user:member-b', relation: 'view_direct', object: `page:${parent}` },
      { user: 'user:member-b', relation: 'restricted', object: `page:${childPub2}` }, // the intermediate is hidden…
      { user: 'user:*', relation: 'published', object: `page:${childPub1}` },
      { user: 'user:*', relation: 'published', object: `page:${childPub2}` },
      { user: 'user:*', relation: 'published', object: `page:${grandUnderC1}` },
      { user: 'user:*', relation: 'published', object: `page:${grandUnderC2}` },
      { user: 'user:member-b', relation: 'view_direct', object: `page:${grandUnderC2}` }, // …but its child is granted
    ]
    await writeTuples(fgaClient, grants)
    try {
      const rows = await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:member-b' })
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.has(childPub2)).toBe(false)         // the unviewable intermediate never leaks
      expect(byId.get(grandUnderC2)?.depth).toBe(0)   // its viewable child re-roots to the dropped node's level
    } finally {
      await deleteTuples(fgaClient, grants).catch(() => {})
    }
  })

  it('CROSS-TENANT: another tenant\'s page can never be parented into this tree (schema/RLS boundary)', async () => {
    // The pages FK/RLS make a cross-tenant parent_id structurally impossible; if an insert ever succeeded,
    // the tenant-scoped (RLS) recursive CTE still could not see the foreign row. Accept either proof.
    let inserted: string | null = null
    try {
      const [row] = await adminPool<{ id: string }[]>`
        INSERT INTO pages (tenant_id, space_id, title, parent_id, published_md, published_at)
        VALUES ('tenant_acme', (SELECT id FROM spaces WHERE tenant_id = 'tenant_acme' LIMIT 1), 'Acme Intruder', ${parent}, 'x', now())
        RETURNING id
      `
      inserted = row?.id ?? null
    } catch {
      return // constraint refused the cross-tenant parent — the boundary holds at the schema layer
    }
    try {
      const rows = await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:dev-user' })
      expect(rows.map((r) => r.id)).not.toContain(inserted)
      expect(rows.map((r) => r.title)).not.toContain('Acme Intruder')
    } finally {
      if (inserted) await adminPool`DELETE FROM pages WHERE id = ${inserted}`.catch(() => {})
    }
  })
})

// #370 / ADR-145 §4 (carried from #353 Hole A): the PUBLIC snapshot resolves as `user:anonymous`, NEVER as
// the publisher. THE binding anti-test: a member-only tagged page MUST NOT appear in the anonymous snapshot.
describe('resolveAnonymousListSnapshot + bake/substitute (#370)', () => {
  let pubHub!: string
  let pubTagged!: string
  let memberOnlyTagged!: string
  const anonGrants: { user: string; relation: string; object: string }[] = []

  beforeAll(async () => {
    pubHub = await mkPage('Public Hub', 'hub')
    pubTagged = await mkPage('Public Tagged', fm('[shared]'))
    memberOnlyTagged = await mkPage('Secret Tagged', fm('[shared]'))
    // The hub AND the public tagged page get the public grant; memberOnlyTagged stays members-only.
    anonGrants.push(
      { user: 'user:*', relation: 'view_base', object: `page:${pubHub}` },
      { user: 'user:*', relation: 'view_base', object: `page:${pubTagged}` },
    )
    await writeTuples(fgaClient, anonGrants)
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, anonGrants).catch(() => {})
  }, 60_000)

  it('resolves the public subset; a member-only tagged page never enters the snapshot (list OR count)', async () => {
    const rows = await resolveAnonymousListSnapshot(db, fgaClient, { pageId: pubHub, name: 'tagged', body: 'shared' })
    const found = rows.map((r) => r.id)
    expect(found).toContain(pubTagged)
    expect(found).not.toContain(memberOnlyTagged)
    expect(rows.map((r) => r.title)).not.toContain('Secret Tagged')
  })

  it('a non-public HOST yields an EMPTY snapshot (uniform 404 → [], no public existence oracle)', async () => {
    const rows = await resolveAnonymousListSnapshot(db, fgaClient, { pageId: hub, name: 'tagged', body: 'shared' })
    expect(rows).toEqual([])
  })

  it('CHILDREN TREE (#370): the anonymous snapshot is a tree — member-only descendants absent, public grandchildren re-rooted', async () => {
    // pubHub > secretMid (member-only, published) > pubGrand (public, published): the anonymous tree must
    // show pubGrand at depth 0 (re-rooted past the hidden intermediate) and never carry secretMid.
    const secretMid = await mkPage('Secret Mid', 'sm', pubHub)
    const pubGrand = await mkPage('Public Grand', 'pg', secretMid)
    const g = [{ user: 'user:*', relation: 'view_base', object: `page:${pubGrand}` }]
    await writeTuples(fgaClient, g)
    try {
      const rows = await resolveAnonymousListSnapshot(db, fgaClient, { pageId: pubHub, name: 'children', body: '' })
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.has(secretMid)).toBe(false) // member-only page: absent from the PUBLIC tree at any depth
      expect(rows.map((r) => r.title)).not.toContain('Secret Mid')
      expect(byId.get(pubGrand)?.depth).toBe(0) // re-rooted to the nearest visible ancestor (the hub root)
    } finally {
      await deleteTuples(fgaClient, g).catch(() => {})
    }
  })

  it('bake + substitute end-to-end: `:::tagged` becomes a static list of the PUBLIC pages only', async () => {
    const md = `# Hub\n\n:::tagged\nshared\n:::\n\ntail`
    const snapshot = await bakeListSnapshot(db, fgaClient, { pageId: pubHub, md })
    expect(snapshot.blocks).toHaveLength(1)
    expect(snapshot.blocks[0]!.results.map((r) => r.id)).toContain(pubTagged)
    expect(snapshot.blocks[0]!.results.map((r) => r.id)).not.toContain(memberOnlyTagged)

    const out = substituteListSnapshots(md, snapshot)
    expect(out).not.toContain(':::tagged') // no live-resolution hook on the public surface
    expect(out).toContain(`(/p/${pubTagged})`)
    expect(out).not.toContain(`/p/${memberOnlyTagged}`)
    expect(out).not.toContain('Secret Tagged')
  })
})

// substituteListSnapshots / renderListSnapshot — pure, no I/O. A MISSING or count-mismatched snapshot fails
// SAFE (renders nothing), never leaves a live directive on the anonymous surface.
describe('substituteListSnapshots (#370 — pure)', () => {
  const snap = (blocks: { spec: string; results: { id: string; title: string }[] }[]): ListSnapshot => ({ v: 1, blocks })

  it('replaces `:::tagged` and `:::children` blocks with their lists, in document order', () => {
    const md = `a\n\n:::tagged\nrecipes\n:::\n\nb\n\n:::children\n:::\n`
    const out = substituteListSnapshots(md, snap([
      { spec: 'tagged recipes', results: [{ id: 'p1', title: 'One' }] },
      { spec: 'children', results: [{ id: 'p2', title: 'Two' }, { id: 'p3', title: 'Three' }] },
    ]))
    expect(out).toBe(`a\n\n- [One](/p/p1)\n\nb\n\n- [Two](/p/p2)\n- [Three](/p/p3)\n`)
  })

  it('an EMPTY result renders nothing (no empty box)', () => {
    const out = substituteListSnapshots(`x\n:::tagged\nrecipes\n:::\ny`, snap([{ spec: 'tagged recipes', results: [] }]))
    expect(out).toBe(`x\n\ny`)
  })

  it('a MISSING snapshot collapses every list block to nothing (fail-safe)', () => {
    expect(substituteListSnapshots(`:::tagged\nrecipes\n:::`, null)).toBe('')
    expect(substituteListSnapshots(`:::children\n:::`, undefined)).toBe('')
  })

  it('a count-mismatched snapshot collapses the unmatched block (positional alignment, fail-safe)', () => {
    const md = `:::tagged\na\n:::\n:::children\n:::`
    const out = substituteListSnapshots(md, snap([{ spec: 'tagged a', results: [{ id: 'p1', title: 'One' }] }]))
    expect(out).toContain('- [One](/p/p1)')
    expect(out).not.toContain(':::children')
  })

  it('depth renders as a NESTED Markdown bullet list (two spaces per level) — #370', () => {
    const out = substituteListSnapshots(`:::children\n:::`, snap([
      { spec: 'children', results: [{ id: 'p1', title: 'Top' }, { id: 'p2', title: 'Kid', depth: 1 } as { id: string; title: string }, { id: 'p3', title: 'Top2' }] },
    ]))
    expect(out).toBe('- [Top](/p/p1)\n  - [Kid](/p/p2)\n- [Top2](/p/p3)')
  })

  it('escapes Markdown-link metacharacters in a title (no injection into the static list)', () => {
    const out = substituteListSnapshots(`:::children\n:::`, snap([{ spec: 'children', results: [{ id: 'p1', title: 'a] (x) [b\\c' }] }]))
    expect(out).toBe('- [a\\] (x) \\[b\\\\c](/p/p1)')
  })

  it('leaves markdown with no list blocks untouched', () => {
    const md = `# title\n\n:::note\nhi\n:::\n`
    expect(substituteListSnapshots(md, null)).toBe(md)
  })
})

// getPublished substitutes the snapshot for a GUEST (share_link) but leaves the directives literal for a
// MEMBER (who resolves them live + viewer-scoped via the member-only /list route).
describe('getPublished guest vs member list directives (#370)', () => {
  let gHub!: string
  let gTagged!: string
  let guestDoc!: string
  const grants: { user: string; relation: string; object: string }[] = []

  beforeAll(async () => {
    gHub = await mkPage('G Hub', 'hub')
    gTagged = await mkPage('G Tagged', fm('[gshared]'))
    guestDoc = await mkPage('Guest Doc', null)
    const md = `# Guest Doc\n\n:::tagged\ngshared\n:::\n`
    grants.push(
      { user: 'user:*', relation: 'view_base', object: `page:${guestDoc}` }, // anonymous can view the host
      { user: 'user:*', relation: 'view_base', object: `page:${gTagged}` },
      { user: 'user:member-g', relation: 'view_direct', object: `page:${guestDoc}` },
      { user: 'share_link:tlink-g', relation: 'view_direct', object: `page:${guestDoc}` },
    )
    await writeTuples(fgaClient, grants)
    const snap = await bakeListSnapshot(db, fgaClient, { pageId: guestDoc, md })
    await adminPool`UPDATE pages SET published_md = ${md}, published_at = now(), published_query_snapshot = ${JSON.stringify(snap)}::jsonb WHERE id = ${guestDoc}`
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, grants).catch(() => {})
  }, 60_000)

  it('a MEMBER gets the literal `:::tagged` (resolves live + viewer-scoped via /list)', async () => {
    const r = await getPublished(db, fgaClient, { pageId: guestDoc, subject: 'user:member-g' })
    expect(r.publishedMd).toContain(':::tagged')
  })

  it('a GUEST gets the static anonymous list — no live directive, only public pages', async () => {
    const r = await getPublished(db, fgaClient, { pageId: guestDoc, subject: 'share_link:tlink-g' })
    expect(r.publishedMd).not.toContain(':::tagged')
    expect(r.publishedMd).toContain(`(/p/${gTagged})`)
  })
})

describe('GET /pages/:id/list route (#370 — members only)', () => {
  let app: FastifyInstance
  let guestTok: string
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
  }, 30_000)
  afterAll(async () => { await app.close() }, 30_000)

  it('a member gets a list (200); an unknown directive name returns [] (never an error)', async () => {
    const ok = await app.inject({ method: 'GET', url: '/pages/demo/list?name=children', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(ok.statusCode).toBe(200)
    expect(Array.isArray(ok.json())).toBe(true)
    const unknown = await app.inject({ method: 'GET', url: '/pages/demo/list?name=evil', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toEqual([])
  })

  it('ANTI-TEST: a share_link (guest) token is REJECTED — a guest never triggers a live reverse-lookup', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/list?name=tagged&body=x', headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.statusCode).not.toBe(200)
  })
})
