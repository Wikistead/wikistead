// Revision ydoc offload (#113 / ADR-062). Unit-tests the dual-read/offload helper with a fake
// storage (LOUD dangling, S3-first-no-key-on-failure, dual-read precedence) + an integration
// assertion that publish actually offloads (ydoc_key set, inline ydoc NULL, content round-trips).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import type { StorageDriver } from '../storage/index.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { getRevisionContent } from '../routes/revisions.js'
import { storeRevisionYdoc, readRevisionYdoc } from '../routes/revision-ydoc.js'
import type { Tenant } from '@wikistead/types'

// Minimal in-memory StorageDriver for the helper unit tests (only put/get exercised).
function fakeStorage() {
  const objs = new Map<string, Uint8Array>()
  const state = { fail: false }
  const drv = {
    objs, state,
    async putObject(key: string, bytes: Uint8Array) { if (state.fail) throw new Error('S3 down'); objs.set(key, bytes) },
    async getObject(key: string) { const b = objs.get(key); if (!b) throw new Error('NoSuchKey'); return b },
  }
  return drv as unknown as StorageDriver & { objs: Map<string, Uint8Array>; state: { fail: boolean } }
}

describe('revision-ydoc helper (#113 / ADR-062)', () => {
  it('storeRevisionYdoc puts the bytes (S3-first) and returns a tenant-namespaced key', async () => {
    const s = fakeStorage()
    const key = await storeRevisionYdoc(s, 'tenantX', new Uint8Array([1, 2, 3]))
    expect(key.startsWith('revisions/tenantX/')).toBe(true)
    expect(Array.from(s.objs.get(key)!)).toEqual([1, 2, 3])
  })

  it('storeRevisionYdoc throws on put failure and writes NO key (no dangling pointer)', async () => {
    const s = fakeStorage(); s.state.fail = true
    await expect(storeRevisionYdoc(s, 'tenantX', new Uint8Array([9]))).rejects.toThrow()
    expect(s.objs.size).toBe(0) // nothing persisted; caller never gets a key to write
  })

  it('readRevisionYdoc prefers ydoc_key (storage) over inline', async () => {
    const s = fakeStorage()
    const key = await storeRevisionYdoc(s, 't', new Uint8Array([7]))
    const bytes = await readRevisionYdoc(s, { ydoc: Buffer.from([0]), ydoc_key: key })
    expect(Array.from(bytes)).toEqual([7]) // storage wins, not the inline [0]
  })

  it('readRevisionYdoc falls back to inline ydoc for legacy rows (no key)', async () => {
    const bytes = await readRevisionYdoc(fakeStorage(), { ydoc: Buffer.from([5, 6]), ydoc_key: null })
    expect(Array.from(bytes)).toEqual([5, 6])
  })

  it('readRevisionYdoc throws LOUD on a dangling pointer (key set, object missing)', async () => {
    await expect(readRevisionYdoc(fakeStorage(), { ydoc: null, ydoc_key: 'revisions/t/missing' }))
      .rejects.toMatchObject({ code: 'revision_blob_missing' })
  })
})

// ── Integration: publish actually offloads ────────────────────────────────
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
let db: TenantDb, spaceId: string
const pageIds: string[] = []

beforeAll(async () => {
  await driver.ensureIndex()
  await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `revoff-${Date.now().toString(36)}` })).id
}, 30_000)

afterAll(async () => {
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

describe('publish offloads the revision ydoc (#113 / ADR-062)', () => {
  it('writes ydoc_key (not inline ydoc) and the content round-trips through storage', async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'offload-me' })
    pageIds.push(p.id)
    await admin`UPDATE pages SET ydoc = ${ydoc('# offloaded body\n')} WHERE id = ${p.id}`
    const { revisionId } = await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    expect(revisionId).toBeTruthy()

    // The row stores a key, NOT inline bytes (offload-on-write).
    const [row] = await admin<[{ ydoc: Buffer | null; ydoc_key: string | null }]>`
      SELECT ydoc, ydoc_key FROM revisions WHERE id = ${revisionId}
    `
    expect(row.ydoc).toBeNull()
    expect(row.ydoc_key).toMatch(/^revisions\/tenant_dev\//)

    // And the content reads back via dual-read (from storage).
    const { content } = await getRevisionContent(db, fgaClient, storage, { pageId: p.id, revId: revisionId!, userId: 'dev-user', plan: 'pro' })
    expect(content).toContain('offloaded body')
  })
})
