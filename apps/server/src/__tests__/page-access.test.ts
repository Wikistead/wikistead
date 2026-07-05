// Integration test — real Postgres + OpenFGA + Meilisearch, no mocks.
// Phase 4b per-page grant/revoke/list. Only a `manage` holder may grant/revoke/list;
// a grant makes the grantee a real FGA viewer (and a search viewer after reindex); a
// revoke drops them; granting on a DRAFT is how you invite someone to it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteObjectTuples, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, grantPageAccess, revokePageAccess, listPageAccess, restrictPageAccess, unrestrictPageAccess, listPageRestrictions, setPagePrivate, unsetPagePrivate, isPagePrivate, listPages, getPage } from '../routes/pages.js'
import { createShareLink, listShareLinks, revokeShareLink } from '../routes/share-links.js'
import { drainAuditOutbox } from '../audit/outbox.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const GRANTEE = 'user:pa-grantee'
const STRANGER = 'pa-stranger'
const TITLE = `paccess${Date.now().toString(36)}`
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const wait = () => new Promise((r) => setTimeout(r, 500))
const search = (userId: string) => driver.search({ tenantId: TENANT, userId, groups: [], q: TITLE })

let db: TenantDb, spaceId: string, pageId: string

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'pa-space' })).id
  // A DRAFT page (creator-only) — granting on it is exactly "invite to a draft".
  pageId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: TITLE })).id
  await admin`UPDATE pages SET ydoc = ${ydoc(`# ${TITLE}\n`)} WHERE id = ${pageId}`
}, 30_000)

afterAll(async () => {
  await driver.deleteDoc(pageId).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('per-page access (grant/revoke/list)', () => {
  it('a manager grants view (invite to a draft): grantee gains FGA view AND appears in search', async () => {
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(false)
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'view' })
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(true)
    const doc = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(doc!.viewerUsers).toContain(GRANTEE)
    await driver.upsertDoc(doc!)
    await wait()
    expect((await search('pa-grantee')).some((h) => h.id === pageId)).toBe(true)
  })

  it('a non-manager cannot grant (403)', async () => {
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: STRANGER, grantee: 'user:pa-x', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('list returns direct grantees for a manager; a non-manager is rejected (403)', async () => {
    const list = await listPageAccess(fgaClient, db, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(list).toEqual(expect.arrayContaining([
      { grantee: GRANTEE, relation: 'view' },
      { grantee: 'user:dev-user', relation: 'manage' }, // the creator grant
    ]))
    await expect(listPageAccess(fgaClient, db, { pageId, tenantId: TENANT, userId: STRANGER })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('revoke removes FGA view and drops the grantee from search', async () => {
    await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'view' })
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(false)
    const doc = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(doc!.viewerUsers).not.toContain(GRANTEE)
    await driver.upsertDoc(doc!)
    await wait()
    expect((await search('pa-grantee')).some((h) => h.id === pageId)).toBe(false)
  })

  it('rejects an invalid grantee or relation (400) — share_link / wildcard / unknown relation', async () => {
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'share_link:x', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'user:*', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'owner' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('records a durable page.access_granted audit entry when entitled + plan passed (#177)', async () => {
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'user:pa-audit', relation: 'view', plan: 'team' })
    expect(await drainAuditOutbox()).toBeGreaterThanOrEqual(1)
    const rows = await db.sql<{ action: string; target: string; actor: string }[]>`SELECT action, target, actor FROM audit_log WHERE tenant_id = ${TENANT} ORDER BY seq`
    expect(rows.some((r) => r.action === 'page.access_granted' && r.target === `page:${pageId}` && r.actor === 'user:dev-user')).toBe(true)
    await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {}) // clean the extra grantee tuple
  })
})

// #109 / ADR-072 monotonic deny — the restrict write path over the same manage-gated mechanism.
describe('per-page restrict (monotonic deny)', () => {
  const R = 'user:pa-restrictee'
  // A prior test (the audit one) wipes ALL page tuples incl. the creator's `manage`; re-establish it
  // so dev-user can manage the page for these tests.
  beforeAll(async () => { await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'manage', object: `page:${pageId}` }]).catch(() => {}) })
  afterAll(async () => { await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {}) })

  it('restrict makes a granted viewer 404 (view=false); list shows the deny; unrestrict restores', async () => {
    // grant view → the principal can see the page
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: R, relation: 'view' })
    expect(await check(fgaClient, R, 'view', { type: 'page', id: pageId })).toBe(true)
    // restrict → deny wins, view=false (the page 404s for them everywhere)
    await restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', principal: R })
    expect(await check(fgaClient, R, 'view', { type: 'page', id: pageId })).toBe(false)
    // the deny appears in the restriction list (distinct from the grant list)
    expect(await listPageRestrictions(fgaClient, { pageId, userId: 'dev-user' })).toEqual(
      expect.arrayContaining([{ principal: R }]),
    )
    // unrestrict → the grant re-applies, view=true again
    await unrestrictPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', principal: R })
    expect(await check(fgaClient, R, 'view', { type: 'page', id: pageId })).toBe(true)
  })

  it('a non-manager cannot restrict / list restrictions (403)', async () => {
    await expect(restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: STRANGER, principal: R }))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(listPageRestrictions(fgaClient, { pageId, userId: STRANGER })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a wildcard / share_link restrictee (400)', async () => {
    await expect(restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', principal: 'user:*' }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', principal: 'share_link:x' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

// #109 / ADR-098 — the PRIVATE (allowlist) write path over the same manage-gated mechanism. The core
// invariant is public⊥private: setting private strips the public grant so is_public flips to false.
describe('per-page private (ADR-098 allowlist)', () => {
  const publicTuple = () => ({ user: 'user:*', relation: 'view_base', object: `page:${pageId}` })
  const ALLOWED = 'user:pa-allowed'
  // The restrict describe's afterAll wiped the page tuples incl. the creator's `manage`; re-establish it.
  beforeAll(async () => { await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'manage', object: `page:${pageId}` }]).catch(() => {}) })
  afterAll(async () => { await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {}) })
  afterEach(async () => {
    await unsetPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' }).catch(() => {})
    await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {}) // clear public + direct grants
    // restore the creator's manage grant that deleteObjectTuples wiped, so later tests still pass
    await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'manage', object: `page:${pageId}` }]).catch(() => {})
  })

  it('setPagePrivate marks private, STRIPS public (is_public → false), keeps a direct allow grant', async () => {
    // make the page public + add a direct allow-listed viewer
    await writeTuples(fgaClient, [publicTuple()])
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: ALLOWED, relation: 'view' })
    const before = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(before!.isPublic).toBe(true) // public before

    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(await isPagePrivate(fgaClient, { pageId, userId: 'dev-user' })).toBe(true)

    // public⊥private write boundary: is_public flips false + the public grant is gone.
    const after = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(after!.isPublic).toBe(false)
    expect(await check(fgaClient, 'user:pa-anon', 'view', { type: 'page', id: pageId })).toBe(false) // no longer public
    // the direct allow-listed grantee still views (the allow list survives private).
    expect(await check(fgaClient, ALLOWED, 'view', { type: 'page', id: pageId })).toBe(true)
  })

  it('a private page drops space-inherited members from the search doc (slice 3 — stage-1 accurate)', async () => {
    const SPACE_MEMBER = 'user:pa-spacemember'
    // simulate a PUBLISHED page (page#space link) + a space viewer with NO direct page grant.
    await writeTuples(fgaClient, [
      { user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` },
      { user: SPACE_MEMBER, relation: 'viewer', object: `space:${spaceId}` },
    ])
    const shared = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(shared!.viewerUsers).toContain(SPACE_MEMBER) // inherits via space while non-private

    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    const priv = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(priv!.viewerUsers).not.toContain(SPACE_MEMBER) // space inheritance cut → dropped from stage-1

    await deleteTuples(fgaClient, [{ user: SPACE_MEMBER, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  })

  it('#109 Fix A: making a page private REVOKES its page share links (no zombie survives the private cut)', async () => {
    // a page share link is a DIRECT grant (share_link:<id> → view page) NOT routed through `viewer from space`.
    const link = await createShareLink(db, fgaClient, { tenantId: TENANT, plan: 'free', userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null })
    expect(await check(fgaClient, `share_link:${link.id}`, 'view', { type: 'page', id: pageId })).toBe(true) // active before

    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })

    // revoked: FGA tuple gone (view=false) AND DB row revoked (not in the active list → no zombie in linkCount).
    expect(await check(fgaClient, `share_link:${link.id}`, 'view', { type: 'page', id: pageId })).toBe(false)
    const active = await listShareLinks(db, fgaClient, { userId: 'dev-user', resource: { type: 'page', id: pageId } })
    expect(active.find((l) => l.id === link.id)).toBeUndefined()

    // one-way: private OFF restores space inheritance but does NOT resurrect the revoked link.
    await unsetPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(await check(fgaClient, `share_link:${link.id}`, 'view', { type: 'page', id: pageId })).toBe(false)
  })

  it('#109 Fix A (②): privatising a page does NOT revoke the SPACE share link (page view is cut by the model, not the DB)', async () => {
    // A space link grants viewer ON THE SPACE; page view flows via `viewer from space but not private`,
    // so privatising already blocks it at the model — Fix A must leave the space link ROW untouched
    // (Fix A queries only resource_type='page'). Over-revoking a space link would break every other page.
    const spaceLink = await createShareLink(db, fgaClient, { tenantId: TENANT, plan: 'free', userId: 'dev-user', resource: { type: 'space', id: spaceId }, capability: 'view', expiresInSeconds: null })

    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })

    // The space link stays ACTIVE (its space viewer tuple, and thus every non-private page, is unaffected).
    const spaceLinks = await listShareLinks(db, fgaClient, { userId: 'dev-user', resource: { type: 'space', id: spaceId } })
    expect(spaceLinks.find((l) => l.id === spaceLink.id)).toBeDefined()
    await revokeShareLink(db, fgaClient, { id: spaceLink.id, userId: 'dev-user', tenantId: TENANT }).catch(() => {})
  })

  it('#109 Fix A: privatising a page does NOT revoke another page\'s share links (scoped to the page)', async () => {
    const other = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'other' })
    const otherLink = await createShareLink(db, fgaClient, { tenantId: TENANT, plan: 'free', userId: 'dev-user', resource: { type: 'page', id: other.id }, capability: 'view', expiresInSeconds: null })
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    // the OTHER page's link is untouched.
    expect(await check(fgaClient, `share_link:${otherLink.id}`, 'view', { type: 'page', id: other.id })).toBe(true)
    await deleteObjectTuples(fgaClient, `page:${other.id}`).catch(() => {})
  })

  it('unsetPagePrivate clears the marker', async () => {
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(await isPagePrivate(fgaClient, { pageId, userId: 'dev-user' })).toBe(true)
    await unsetPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(await isPagePrivate(fgaClient, { pageId, userId: 'dev-user' })).toBe(false)
  })

  it('#109 Fix B: listPages / getPage expose the private flag to a viewer on the allowlist (lock badge)', async () => {
    // Grant STRANGER view, then privatise: STRANGER is on the allowlist so still sees the page,
    // and both the tree (listPages) and the open page (getPage) carry private=true to render the lock.
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: `user:${STRANGER}`, relation: 'view' })
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    const tree = await listPages(db, fgaClient, { spaceId, subject: `user:${STRANGER}` })
    expect(tree.find((p) => p.id === pageId)?.private).toBe(true)
    expect((await getPage(db, fgaClient, { pageId, userId: STRANGER })).private).toBe(true)
    // A restrict-only (deny) page is NOT private → no lock: unset private, page stays non-private.
    await unsetPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect((await getPage(db, fgaClient, { pageId, userId: STRANGER })).private).toBe(false)
    await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: `user:${STRANGER}`, relation: 'view' })
  })

  it('a non-manager cannot toggle or read private (403)', async () => {
    await expect(setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(unsetPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(isPagePrivate(fgaClient, { pageId, userId: STRANGER })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('records a durable page.made_private audit entry when entitled + plan passed (#177)', async () => {
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', plan: 'team' })
    expect(await drainAuditOutbox()).toBeGreaterThanOrEqual(1)
    const rows = await db.sql<{ action: string; target: string; actor: string }[]>`SELECT action, target, actor FROM audit_log WHERE tenant_id = ${TENANT} ORDER BY seq`
    expect(rows.some((r) => r.action === 'page.made_private' && r.target === `page:${pageId}` && r.actor === 'user:dev-user')).toBe(true)
  })
})
