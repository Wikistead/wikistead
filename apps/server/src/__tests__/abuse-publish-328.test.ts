// #328 / ADR-140: the abuse filter WIRED into publishPage — the tenant config is read and a trip is a 422 with a
// static reason code, the content untouched. Real Postgres (tenant_dev). The config is set on the shared tenant
// and ALWAYS reset in afterEach so no other publish test is affected.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
let db!: TenantDb, spaceId!: string
const pageIds: string[] = []

const setAbuse = (cfg: { shrinkRatio?: number | null; bannedWords?: string[] }) =>
  admin`UPDATE tenant_settings SET abuse_shrink_ratio = ${cfg.shrinkRatio ?? null}, abuse_banned_words = ${cfg.bannedWords ?? []} WHERE tenant_id = ${TENANT}`
const resetAbuse = () => admin`UPDATE tenant_settings SET abuse_shrink_ratio = NULL, abuse_banned_words = ${[] as string[]} WHERE tenant_id = ${TENANT}`

// create + publish a page with `body` as the published text; returns its id.
async function publishedPage(body: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'abuse' })
  pageIds.push(p.id)
  await admin`UPDATE pages SET ydoc = ${ydoc(body)} WHERE id = ${p.id}`
  await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  return p.id
}

beforeAll(async () => {
  await driver.ensureIndex()
  await storage.ensureBucket()
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${TENANT}) ON CONFLICT (tenant_id) DO NOTHING`
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `abuse-${Date.now().toString(36)}` })).id
}, 30_000)

afterEach(async () => { await resetAbuse() }) // never leave the shared tenant in a filtered state

afterAll(async () => {
  await resetAbuse()
  for (const id of pageIds) {
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('publishPage abuse filter (#328 / ADR-140)', () => {
  it('all-permissive (default) never blocks — a big shrink publishes fine', async () => {
    const id = await publishedPage('x'.repeat(500))
    await admin`UPDATE pages SET ydoc = ${ydoc('tiny')} WHERE id = ${id}` // 99% shrink, but the filter is off
    await expect(publishPage(db, fgaClient, driver, storage, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' }))
      .resolves.toMatchObject({ noop: false })
  })

  it('mass_delete: a wipe below the shrink ratio is a 422 with reason (content untouched)', async () => {
    const id = await publishedPage('x'.repeat(1000))
    await admin`UPDATE pages SET ydoc = ${ydoc('gone')} WHERE id = ${id}`
    await setAbuse({ shrinkRatio: 0.2 })
    await expect(publishPage(db, fgaClient, driver, storage, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' }))
      .rejects.toMatchObject({ statusCode: 422, reason: 'mass_delete' })
    // the published text is unchanged (decide-only, never edits content)
    const [row] = await admin`SELECT published_md FROM pages WHERE id = ${id}`
    expect((row.published_md as string).length).toBe(1000)
  })

  it('banned_content: an ADDED banned word is a 422 with reason', async () => {
    const id = await publishedPage('clean starting body')
    await admin`UPDATE pages SET ydoc = ${ydoc('clean starting body with a spamword added')} WHERE id = ${id}`
    await setAbuse({ bannedWords: ['spamword'] })
    await expect(publishPage(db, fgaClient, driver, storage, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' }))
      .rejects.toMatchObject({ statusCode: 422, reason: 'banned_content' })
  })

  it('a banned word already in the published text does NOT block a later benign edit', async () => {
    const id = await publishedPage('this body already has spamword in it')
    await admin`UPDATE pages SET ydoc = ${ydoc('this body already has spamword in it, plus a fix')} WHERE id = ${id}`
    await setAbuse({ bannedWords: ['spamword'] })
    await expect(publishPage(db, fgaClient, driver, storage, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' }))
      .resolves.toMatchObject({ noop: false })
  })
})
