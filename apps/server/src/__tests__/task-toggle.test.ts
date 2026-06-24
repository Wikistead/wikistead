// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// ADR-019: the no-revision task-checkbox toggle. The load-bearing guarantees (authz-
// critical — D3/D4 are security boundaries):
//   - edit-gated: a non-editor is rejected (403),
//   - the "checkbox-only diff" guard rejects (409) any draft that differs from the
//     published snapshot by anything other than the single expected checkbox flip
//     (so the no-revision path cannot smuggle real content past history),
//   - a successful toggle updates published_md but creates NO revision,
//   - a single checkbox flip succeeds even though the page is "dirty" by exactly that
//     flip (the normal success path).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage, getPublished, toggleTask } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

const BASE = `# Tasks\n\n- [ ] alpha\n- [ ] beta\n` // two unchecked task items: index 0, 1
// Simulate a collab draft save: persist ydoc + set the unpublished flag (as storeYdoc does).
const setDraft = (pageId: string, text: string) =>
  admin`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))}, has_unpublished_changes = true WHERE id = ${pageId}`
const revisionCount = async (pageId: string) =>
  (await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`)[0].n

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'task-toggle-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Task Toggle' })
  pageId = page.id
  // Publish the baseline so published_md == draft (both unchecked). revisions = 1.
  await setDraft(pageId, BASE)
  await publishPage(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
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

// NOTE: the success case runs LAST so published_md stays the unchecked baseline while
// the 409 cases compare against it.
describe('task-checkbox toggle (no-revision, ADR-019)', () => {
  it('is edit-gated: a non-editor is rejected (403)', async () => {
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\n`) // a valid single flip…
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:toggle-rando-xyz', index: 0 }))
      .rejects.toMatchObject({ statusCode: 403 }) // …still 403: FGA edit is checked first
  })

  it('rejects (409) when the draft mixes in non-checkbox changes', async () => {
    // a checkbox flip PLUS other content — must not slip a real edit past history
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\nstealth edit\n`)
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects (409) when nothing flipped, or the flip is not at the claimed index', async () => {
    await setDraft(pageId, BASE) // identical to published → zero flips
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 })
    await setDraft(pageId, `# Tasks\n\n- [ ] alpha\n- [x] beta\n`) // beta (index 1) flipped…
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 }) // …but index 0 claimed → reject
  })

  it('a single checkbox flip succeeds, updates published_md, and creates NO revision', async () => {
    const before = await revisionCount(pageId)
    expect(before).toBe(1) // just the baseline publish
    // the page is now "dirty" by exactly one flip (alpha checked) — the success path
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\n`)
    await toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', index: 0 })

    const pub = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub.publishedMd).toContain('- [x] alpha')
    expect(pub.publishedMd).toContain('- [ ] beta')
    expect(pub.hasUnpublishedChanges).toBe(false) // draft == published again
    expect(await revisionCount(pageId)).toBe(before) // NO new revision — history unpolluted
  })
})
