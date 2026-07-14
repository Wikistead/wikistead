// #324 / ADR-134: `:::query` — a read-only dynamic list resolved FOR THE VIEWER. Every branch is view-filtered
// (existence-hiding): `backlinks`/`tag` reuse getBacklinks; `children` view-gates the parent then per-child.
// PUBLISHED-only throughout (the published graph). Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// resolveAnonymousQuerySnapshot imported below (with the other pages.ts exports)
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, getQueryResults, getPublished, parseQuerySpec, resolveAnonymousQuerySnapshot, bakeQuerySnapshot, substituteQuerySnapshots, type QuerySnapshot } from '../routes/pages.js'
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
let tagPage!: string
let tagMember!: string // links to tagPage → a member of that tag

async function mkPage(title: string, md: string | null, parentId?: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  ids.push(p.id)
  if (md !== null) await adminPool`UPDATE pages SET published_md = ${md}, published_at = now() WHERE id = ${p.id}`
  return p.id
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'query-space' })
  spaceId = space.id
  parent = await mkPage('Parent', 'parent body')
  childPub1 = await mkPage('Child One', 'c1', parent)
  childPub2 = await mkPage('Child Two', 'c2', parent)
  childDraft = await mkPage('Child Draft', null, parent) // never published
  tagPage = await mkPage('recipes', 'the recipes tag page')
  tagMember = await mkPage('Carbonara', `tagged [recipes](/p/${tagPage})`)
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('parseQuerySpec (#324)', () => {
  it('parses the three v1 spec forms and treats garbage as null (0 results, never a parse error)', () => {
    expect(parseQuerySpec('backlinks')).toEqual({ type: 'backlinks' })
    expect(parseQuerySpec('children')).toEqual({ type: 'children' })
    expect(parseQuerySpec('tag abc123')).toEqual({ type: 'tag', target: 'abc123' })
    expect(parseQuerySpec('tag:abc123')).toEqual({ type: 'tag', target: 'abc123' })
    // leading/trailing blank lines are tolerated (the first non-empty line is the spec)
    expect(parseQuerySpec('\n  children  \n')).toEqual({ type: 'children' })
    // garbage / empty / multi-token tag → null
    expect(parseQuerySpec('')).toBeNull()
    expect(parseQuerySpec('what is this')).toBeNull()
    expect(parseQuerySpec('tag a b')).toBeNull()
  })
})

describe('getQueryResults children (#324 / ADR-134)', () => {
  it('returns the PUBLISHED child pages of the parent, and NOT the unpublished draft child (published graph)', async () => {
    const rows = await getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'children' }, subject: 'user:dev-user' })
    const found = rows.map((r) => r.id)
    expect(found).toContain(childPub1)
    expect(found).toContain(childPub2)
    expect(found).not.toContain(childDraft) // draft → absent until publish
    expect(rows.find((r) => r.id === childPub1)?.title).toBe('Child One')
  })

  it('authz: a caller who CANNOT view the parent gets a uniform 404 (existence-hiding), not a child list', async () => {
    // `other-member` has no grant in this space → cannot view `parent`, so its children can't be enumerated.
    await expect(getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'children' }, subject: 'user:other-member' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('a non-existent parent id is the SAME uniform 404', async () => {
    await expect(getQueryResults(db, fgaClient, { pageId: 'no-such-page', spec: { type: 'children' }, subject: 'user:dev-user' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  // The per-child omit-on-deny loop: a caller who can VIEW the parent but NOT a given child gets that child
  // ABSENT from the list (and from the count) — the child's existence/title never leaks. #218 / ADR-103: a
  // direct grant on the PARENT now CASCADES to its children (view_direct from parent), so the way to make a
  // child un-viewable while the parent is viewable is the monotonic `restricted` deny (which wins over the
  // inherited grant), not "grant only some children". Grant `member-b` view on the parent (→ both children
  // inherit) then RESTRICT childPub2 → childPub2 is omitted; childPub1 stays.
  it('authz: a caller who can view the parent but NOT a child gets that child OMITTED (no title/count leak)', async () => {
    const grants = [
      { user: 'user:member-b', relation: 'view_direct', object: `page:${parent}` }, // cascades to child1 + child2
      { user: 'user:member-b', relation: 'restricted', object: `page:${childPub2}` }, // ...but child2 is denied (deny wins)
      // #218 / ADR-103 addendum (DRAFT GATE): the parent-grant cascade is `view_base_from_parent AND published`,
      // so a child only INHERITS the parent grant once PUBLISHED. These children carry published_md (raw UPDATE in
      // mkPage) but that shortcut skips the FGA markers publishPage writes — add the `published@user:*` marker so
      // the cascade reaches them, matching a really-published child.
      { user: 'user:*', relation: 'published', object: `page:${childPub1}` },
      { user: 'user:*', relation: 'published', object: `page:${childPub2}` },
    ]
    await writeTuples(fgaClient, grants)
    try {
      const rows = await getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'children' }, subject: 'user:member-b' })
      const found = rows.map((r) => r.id)
      expect(found).toContain(childPub1) // inherited the parent grant → visible
      expect(found).not.toContain(childPub2) // restricted (deny) → omitted, not merely hidden in the UI
    } finally {
      await deleteTuples(fgaClient, grants).catch(() => {})
    }
  })
})

describe('getQueryResults tag/backlinks (#324 — reuse getBacklinks view-filter)', () => {
  it('tag <id> lists the pages linking to that tag page (its members)', async () => {
    const rows = await getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'tag', target: tagPage }, subject: 'user:dev-user' })
    expect(rows.map((r) => r.id)).toContain(tagMember)
  })

  it('tag <id> to a target the caller cannot view is a uniform 404 (getBacklinks target gate, existence-hiding)', async () => {
    await expect(getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'tag', target: tagPage }, subject: 'user:other-member' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('backlinks lists the pages linking to THIS page', async () => {
    const rows = await getQueryResults(db, fgaClient, { pageId: tagPage, spec: { type: 'backlinks' }, subject: 'user:dev-user' })
    expect(rows.map((r) => r.id)).toContain(tagMember)
  })
})

// #353 / ADR-134 rev2 (Hole A): resolveAnonymousQuerySnapshot — the PUBLIC snapshot resolves as `user:anonymous`,
// NEVER as the publisher. THE binding anti-test: a member-only page that matches a query MUST NOT appear in the
// anonymous snapshot (else the publisher's grants would leak member-only titles onto the public surface, the
// #244 class). `user:anonymous` is a user-type principal, so a `view_base@user:*` grant (public) matches it while
// a members-only page (no such grant) does not — the existing per-item view-filter drops it.
describe('resolveAnonymousQuerySnapshot (#353 / ADR-134 rev2 Hole A)', () => {
  let anonTag!: string
  let pubMember!: string
  let memberOnly!: string
  const anonGrants: { user: string; relation: string; object: string }[] = []

  beforeAll(async () => {
    anonTag = await mkPage('public-tag', 'the public tag page')
    pubMember = await mkPage('Public Member', `tagged [public-tag](/p/${anonTag})`)
    memberOnly = await mkPage('Secret Member', `tagged [public-tag](/p/${anonTag})`)
    // Make the tag page AND the public member publicly viewable (view_base@user:* — the phase-4 publish switch's
    // public grant). memberOnly is published but has NO public grant → viewable only to members.
    anonGrants.push(
      { user: 'user:*', relation: 'view_base', object: `page:${anonTag}` },
      { user: 'user:*', relation: 'view_base', object: `page:${pubMember}` },
    )
    await writeTuples(fgaClient, anonGrants)
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, anonGrants).catch(() => {})
  }, 60_000)

  it('resolves the public subset: the public member appears', async () => {
    const rows = await resolveAnonymousQuerySnapshot(db, fgaClient, { pageId: anonTag, spec: { type: 'tag', target: anonTag } })
    expect(rows.map((r) => r.id)).toContain(pubMember)
  })

  it('EXCLUDES a member-only page — its title never enters the public snapshot (the ADR-134 rev2 binding)', async () => {
    const rows = await resolveAnonymousQuerySnapshot(db, fgaClient, { pageId: anonTag, spec: { type: 'tag', target: anonTag } })
    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain(memberOnly) // member-only → absent from list AND count (no public leak)
    expect(rows.map((r) => r.title)).not.toContain('Secret Member')
  })

  it('a non-public TARGET yields an EMPTY snapshot (uniform 404 → [], no public existence oracle)', async () => {
    // tagPage (from the outer setup) has no public grant → user:anonymous cannot view the target → getBacklinks
    // throws a uniform 404, which the snapshot resolver swallows to [] (the publish baker treats it as "no
    // snapshot", never a leak or an error surfaced to the public reader).
    const rows = await resolveAnonymousQuerySnapshot(db, fgaClient, { pageId: tagPage, spec: { type: 'tag', target: tagPage } })
    expect(rows).toEqual([])
  })

  // bakeQuerySnapshot + substituteQuerySnapshots end-to-end (the shape the publish baker stores and the public
  // route substitutes). The baked list is the ANONYMOUS subset, so a member-only match is absent from the
  // substituted public markdown too — the binding property, verified through the whole pipeline.
  it('bake + substitute: a `:::query` block becomes a static list of the PUBLIC members only', async () => {
    const md = `# Hub\n\n:::query\ntag ${anonTag}\n:::\n\ntail`
    const snapshot = await bakeQuerySnapshot(db, fgaClient, { pageId: anonTag, md })
    expect(snapshot.blocks).toHaveLength(1)
    expect(snapshot.blocks[0]!.results.map((r) => r.id)).toContain(pubMember)
    expect(snapshot.blocks[0]!.results.map((r) => r.id)).not.toContain(memberOnly)

    const out = substituteQuerySnapshots(md, snapshot)
    expect(out).not.toContain(':::query') // the directive is gone — no live-resolution hook on the public surface
    expect(out).toContain(`(/p/${pubMember})`) // the public member is a static internal link
    expect(out).not.toContain(`/p/${memberOnly}`) // the member-only page's id/title never reaches the public markdown
    expect(out).not.toContain('Secret Member')
  })
})

// substituteQuerySnapshots / renderQuerySnapshotList — pure, no I/O. The public/guest render substitutes a baked
// snapshot; a MISSING or count-mismatched snapshot must fail SAFE (render nothing), never leave a live directive.
describe('substituteQuerySnapshots (#353 / ADR-134 rev2 — pure)', () => {
  const snap = (blocks: { spec: string; results: { id: string; title: string }[] }[]): QuerySnapshot => ({ v: 1, blocks })

  it('replaces each `:::query` block with its bullet list, in document order', () => {
    const md = `a\n\n:::query\nchildren\n:::\n\nb\n\n:::query\nbacklinks\n:::\n`
    const out = substituteQuerySnapshots(md, snap([
      { spec: 'children', results: [{ id: 'p1', title: 'One' }] },
      { spec: 'backlinks', results: [{ id: 'p2', title: 'Two' }, { id: 'p3', title: 'Three' }] },
    ]))
    expect(out).toBe(`a\n\n- [One](/p/p1)\n\nb\n\n- [Two](/p/p2)\n- [Three](/p/p3)\n`)
  })

  it('an EMPTY result renders nothing (no empty box)', () => {
    const out = substituteQuerySnapshots(`x\n:::query\nchildren\n:::\ny`, snap([{ spec: 'children', results: [] }]))
    expect(out).toBe(`x\n\ny`)
  })

  it('a MISSING snapshot collapses every query block to nothing (fail-safe — never a live directive on public)', () => {
    const md = `:::query\nchildren\n:::`
    expect(substituteQuerySnapshots(md, null)).toBe('')
    expect(substituteQuerySnapshots(md, undefined)).toBe('')
  })

  it('a count-mismatched snapshot collapses the unmatched block (positional alignment, fail-safe)', () => {
    const md = `:::query\nchildren\n:::\n:::query\nbacklinks\n:::`
    const out = substituteQuerySnapshots(md, snap([{ spec: 'children', results: [{ id: 'p1', title: 'One' }] }]))
    expect(out).toContain('- [One](/p/p1)')
    expect(out).not.toContain(':::query') // the second (unmatched) block collapses to nothing, not a live directive
  })

  it('escapes Markdown-link metacharacters in a title (no injection into the static list)', () => {
    const out = substituteQuerySnapshots(`:::query\nchildren\n:::`, snap([{ spec: 'children', results: [{ id: 'p1', title: 'a] (x) [b\\c' }] }]))
    expect(out).toBe('- [a\\] (x) \\[b\\\\c](/p/p1)')
  })

  it('leaves markdown with no query blocks untouched', () => {
    const md = `# title\n\n:::note\nhi\n:::\n`
    expect(substituteQuerySnapshots(md, null)).toBe(md)
  })
})

// getPublished substitutes the snapshot for a GUEST (share_link) but leaves `:::query` literal for a MEMBER
// (who resolves it live + viewer-scoped via the member-only /query route). The guest sees the same anonymous
// static list as the public surface — no live per-viewer reverse-lookup for a guest (#244 re-entry class).
describe('getPublished guest vs member :::query (#353 / ADR-134 rev2 Hole A)', () => {
  let anonTag2!: string
  let pubMember2!: string
  let guestDoc!: string
  const grants: { user: string; relation: string; object: string }[] = []

  beforeAll(async () => {
    anonTag2 = await mkPage('public-tag-2', 'the tag')
    pubMember2 = await mkPage('Public Member 2', `tagged [x](/p/${anonTag2})`)
    guestDoc = await mkPage('Guest Doc', null)
    const md = `# Guest Doc\n\n:::query\ntag ${anonTag2}\n:::\n`
    grants.push(
      { user: 'user:*', relation: 'view_base', object: `page:${anonTag2}` },
      { user: 'user:*', relation: 'view_base', object: `page:${pubMember2}` },
      { user: 'user:member-g', relation: 'view_direct', object: `page:${guestDoc}` }, // a member who can view guestDoc
      { user: 'share_link:qlink-g', relation: 'view_direct', object: `page:${guestDoc}` }, // a view guest on guestDoc
    )
    await writeTuples(fgaClient, grants)
    const snap = await bakeQuerySnapshot(db, fgaClient, { pageId: guestDoc, md })
    await adminPool`UPDATE pages SET published_md = ${md}, published_at = now(), published_query_snapshot = ${JSON.stringify(snap)}::jsonb WHERE id = ${guestDoc}`
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, grants).catch(() => {})
  }, 60_000)

  it('a MEMBER gets the literal `:::query` (resolves live + viewer-scoped via /query)', async () => {
    const r = await getPublished(db, fgaClient, { pageId: guestDoc, subject: 'user:member-g' })
    expect(r.publishedMd).toContain(':::query') // untouched — the editor macro resolves it live
  })

  it('a GUEST gets the static anonymous list, no `:::query` directive, no member-only leak', async () => {
    const r = await getPublished(db, fgaClient, { pageId: guestDoc, subject: 'share_link:qlink-g' })
    expect(r.publishedMd).not.toContain(':::query') // substituted → no live-resolution hook for a guest
    expect(r.publishedMd).toContain(`(/p/${pubMember2})`) // the public member is a static link
  })
})
