// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// #116 review (the owner point 2): restore is COPY-based, so the prune trigger deleting
// the restored-from revision can never corrupt the result. restoreRevision reads the target
// revision, builds an INDEPENDENT new ydoc, inserts it as a fresh revision, and repoints
// published_* at that NEW revision (published_revision_id is a soft pointer, migration 016).
// This exercises the worst case: the target is the OLDEST revision on a page already at the
// 200 cap, so restore's own insert fires the trigger and prunes the target — yet the restored
// content survives (it was copied into the new revision + published_md before the prune).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { restoreRevision } from '../routes/revisions.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const KEEP = 200 // must match migration 027
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'pro', isolation: 'logical' }) as Tenant
const ydocOf = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))
const TARGET = '# Target\n\nthe old content to restore\n'
const CURRENT = '# Current\n\ndifferent live content\n'

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'pro', name: 'restore-prune-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Restore Prune' })
  pageId = page.id
  // Current live ydoc = different content, so restore actually changes the page.
  await admin`UPDATE pages SET ydoc = ${ydocOf(CURRENT)} WHERE id = ${pageId}`
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

describe('#116 restore is copy-safe even when the trigger prunes the restored-from revision', () => {
  it('restores the OLDEST revision on a page at the 200 cap; content survives the prune', async () => {
    // The target = the OLDEST revision (created_at base). Then fill to exactly KEEP so the page
    // sits at the cap and the target is first to be pruned by the next insert.
    const [target] = await admin<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by, created_at)
      VALUES (${TENANT}, ${pageId}, ${ydocOf(TARGET)}, 'Target', 'user:dev-user', now())
      RETURNING id`
    for (let i = 1; i < KEEP; i++) {
      await admin`
        INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_at)
        VALUES (${TENANT}, ${pageId}, ${ydocOf('filler ' + i)}, ${'f' + i}, now() + (${i} || ' seconds')::interval)`
    }
    const [{ n: before }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    expect(before).toBe(KEEP) // at the cap; target is the oldest

    // Restore the target. Its insert pushes the count to 201 → the trigger prunes the oldest
    // (the target itself). Copy-safety means the restored content still lands.
    await restoreRevision(db, fgaClient, app.valkey, { tenantId: TENANT, pageId, revId: target.id, userId: 'dev-user', plan: 'pro' })

    // The page's PUBLISHED content is the restored target (copied before the prune)…
    const [pg] = await admin<[{ published_md: string; published_revision_id: string | null }]>`
      SELECT published_md, published_revision_id FROM pages WHERE id = ${pageId}`
    expect(pg.published_md).toBe(TARGET)

    // …it points at the NEW revision (independent copy), which exists and is NOT the target…
    expect(pg.published_revision_id).not.toBe(target.id)
    const [{ n: newRevExists }] = await admin<[{ n: number }]>`
      SELECT count(*)::int AS n FROM revisions WHERE id = ${pg.published_revision_id!} AND page_id = ${pageId}`
    expect(newRevExists).toBe(1)

    // …the restored-from target row was pruned (it was the oldest), proving no dangling
    // dependency on it — the content lives on in published_md + the new revision.
    const [{ n: targetGone }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE id = ${target.id}`
    expect(targetGone).toBe(0)

    // Still exactly the cap (201 inserted − 1 pruned).
    const [{ n: after }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    expect(after).toBe(KEEP)
  }, 30_000)
})
