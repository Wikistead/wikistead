// #324 / ADR-134: `:::query` — a read-only dynamic list resolved FOR THE VIEWER. Every branch is view-filtered
// (existence-hiding): `backlinks`/`tag` reuse getBacklinks; `children` view-gates the parent then per-child.
// PUBLISHED-only throughout (the published graph). Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, getQueryResults, parseQuerySpec } from '../routes/pages.js'
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
  // ABSENT from the list (and from the count) — the child's existence/title never leaks. Grant `member-b`
  // view on the parent + childPub1 only; childPub2 is omitted.
  it('authz: a caller who can view the parent but NOT a child gets that child OMITTED (no title/count leak)', async () => {
    // `view_base` is the writable leaf (direct view grants); `view` itself is computed (fga-computed-relation
    // write-ripple), so grants must land on the leaf.
    const grants = [
      { user: 'user:member-b', relation: 'view_base', object: `page:${parent}` },
      { user: 'user:member-b', relation: 'view_base', object: `page:${childPub1}` },
    ]
    await writeTuples(fgaClient, grants)
    try {
      const rows = await getQueryResults(db, fgaClient, { pageId: parent, spec: { type: 'children' }, subject: 'user:member-b' })
      const found = rows.map((r) => r.id)
      expect(found).toContain(childPub1)
      expect(found).not.toContain(childPub2) // not granted → omitted, not merely hidden in the UI
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
