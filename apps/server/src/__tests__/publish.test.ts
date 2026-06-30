// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// 2f-1 draft/publish editing model. The load-bearing guarantees
// - a DRAFT's in-progress body is NOT in search / published reads until publish,
// - editing the draft again does NOT change the published version (nor search)
// until the NEXT publish,
// - publish is edit-gated (a non-editor is rejected),
// - publish records a revision (history = publish history).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { UNLIMITED, registerEntitlementsResolver, resetEntitlementsResolver } from '@wikistead/entitlements'
import { drainOutbox } from '../search/index.js'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage, getPublished, getPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
// Two DISSIMILAR unique tokens — not 1-char variants (Meili typo tolerance would
// cross-match those), so a search for one never accidentally matches the other.
const T1 = `wikipublishone${Date.now().toString(36)}`
const T2 = `zebrarestoretwo${Date.now().toString(36)}`
// Simulate a collab draft save: persist ydoc AND set the unpublished flag (the cheap
// sidebar-badge flag that storeYdoc sets true on every draft save).
const setDraft = (pageId: string, text: string) =>
  admin`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))}, has_unpublished_changes = true WHERE id = ${pageId}`

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let pageId: string

const search = async (q: string) => {
  const res = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
  return (res.json() as { id: string }[]).map((h) => h.id)
}
const drainAndSearch = async (q: string) => { await drainOutbox(app.searchDriver); return search(q) }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'publish-test-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Publish Test' })
  pageId = page.id
  await setDraft(pageId, `# Publish Test\n\n${T1} 東京都庁\n`) // draft body, not yet published
}, 30_000)

afterAll(async () => {
  await app.searchDriver.deleteDoc(pageId).catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('draft/publish editing model', () => {
  it('a draft body is NOT published or searchable until publish', async () => {
    const pub = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub.publishedMd).toBeNull()
    expect(pub.hasUnpublishedChanges).toBe(true) // draft has content, nothing published
    // the cheap sidebar-badge flag agrees (set true by the draft save)
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).hasUnpublishedChanges).toBe(true)
    expect(await drainAndSearch(T1)).not.toContain(pageId) // body not indexed pre-publish
  })

  it('publish promotes the draft: published content + body searchable + a revision', async () => {
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    const pub = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub.publishedMd).toContain(T1)
    expect(pub.hasUnpublishedChanges).toBe(false) // draft == published
    // publish cleared the cheap badge flag too
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).hasUnpublishedChanges).toBe(false)
    expect(await drainAndSearch(T1)).toContain(pageId)
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    expect(n).toBe(1) // history = the publish
  })

  it('publishing with no changes is a no-op — no meaningless revision', async () => {
    // After the previous publish, draft == published. Publishing again must not add
    // a revision (the server is the accurate gate; the UI only disables the button).
    const [{ n: before }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    const res = await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    expect(res.noop).toBe(true)
    const [{ n: after }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    expect(after).toBe(before)
  })

  it('editing the draft again does NOT change the published version (nor search) until the next publish', async () => {
    await setDraft(pageId, `# Publish Test\n\n${T2} 新しい本文\n`) // new draft content
    const pub = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub.hasUnpublishedChanges).toBe(true)
    expect(pub.publishedMd).toContain(T1)      // still the OLD published body
    expect(pub.publishedMd).not.toContain(T2)
    // search still reflects the published version, not the live draft
    expect(await drainAndSearch(T2)).not.toContain(pageId)
    expect(await search(T1)).toContain(pageId)

    // the NEXT publish promotes the new content
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    const pub2 = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub2.publishedMd).toContain(T2)
    expect(await drainAndSearch(T2)).toContain(pageId)
  })

  it('publish is edit-gated: a user without edit is rejected (403)', async () => {
    await expect(publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: 'user:pub-rando-xyz', createdBy: 'user:pub-rando-xyz' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('macro level-cap fortress (#93 / ADR-073)', () => {
  it('rejects a publish whose Markdown exceeds the tenant cap; the default directive cap allows it', async () => {
    const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'cap-test' })
    await setDraft(p.id, ':::note\nhi\n:::\n') // directive-layer content
    try {
      registerEntitlementsResolver(() => ({ ...UNLIMITED, macroLevelCap: 'gfm' })) // cap below directive
      await expect(publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user', plan: 'x' }))
        .rejects.toMatchObject({ statusCode: 422, code: 'macro_level_cap' }) // server fortress rejects over-cap
    } finally {
      resetEntitlementsResolver()
    }
    // default cap = directive (UNLIMITED) → the same content publishes
    const r = await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user', plan: 'x' })
    expect(r.noop).toBe(false)
    await app.searchDriver.deleteDoc(p.id).catch(() => {})
    await deleteObjectTuples(fgaClient, `page:${p.id}`).catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${p.id}`.catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${p.id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${p.id}`.catch(() => {})
  })
})
