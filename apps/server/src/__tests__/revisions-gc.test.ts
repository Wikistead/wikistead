// Revision GC (#113 / ADR-062) — the data-loss-critical reconciler. Verifies the two-stage
// mark/delete + grace guarantees: an orphan blob is marked but NOT deleted on the first run,
// deleted only once past grace; a REFERENCED blob is never touched; a candidate that becomes
// live again is un-marked. Uses an in-memory storage so the object universe is deterministic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import type { StorageDriver } from '../storage/index.js'
import { createPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { runRevisionGc } from '../scripts/revisions-gc.js'
import type { Tenant } from '@wikistead/types'

function fakeStorage() {
  const objs = new Map<string, Uint8Array>()
  const drv = {
    objs,
    async putObject(k: string, b: Uint8Array) { objs.set(k, b) },
    async getObject(k: string) { const b = objs.get(k); if (!b) throw new Error('NoSuchKey'); return b },
    async deleteObject(k: string) { objs.delete(k) },
    async listObjects(prefix: string) { return [...objs.keys()].filter((k) => k.startsWith(prefix)) },
  }
  return drv as unknown as StorageDriver & { objs: Map<string, Uint8Array> }
}

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ORPHAN = `revisions/${TENANT}/gc-orphan-${Date.now().toString(36)}`
const LIVE = `revisions/${TENANT}/gc-live-${Date.now().toString(36)}`

let db: TenantDb, spaceId: string, pageId: string

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `gc-sp-${Date.now().toString(36)}` })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'gc-page' })).id
  // A LIVE revision row pointing at LIVE (ydoc_key only — the offload state).
  await admin`INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by) VALUES (${TENANT}, ${pageId}, ${LIVE}, 'gc', 'user:dev-user')`
  // Clean any stray candidate rows from earlier runs of these fixed-ish keys.
  await admin`DELETE FROM revision_gc_candidates WHERE ydoc_key IN (${ORPHAN}, ${LIVE})`
}, 30_000)

afterAll(async () => {
  await admin`DELETE FROM revision_gc_candidates WHERE ydoc_key IN (${ORPHAN}, ${LIVE})`.catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('runRevisionGc (#113 / ADR-062)', () => {
  it('marks an orphan but does NOT delete it on the first run (within grace), and never touches a live blob', async () => {
    const storage = fakeStorage()
    await storage.putObject(ORPHAN, new Uint8Array([1]), 'application/octet-stream')
    await storage.putObject(LIVE, new Uint8Array([2]), 'application/octet-stream')

    const r = await runRevisionGc(admin, storage, { graceSeconds: 24 * 3600 })
    expect(r.deleted).toBe(0)                         // nothing deleted within grace
    expect(storage.objs.has(ORPHAN)).toBe(true)       // orphan survives (marked only)
    expect(storage.objs.has(LIVE)).toBe(true)         // live blob untouched
    const [cand] = await admin`SELECT 1 FROM revision_gc_candidates WHERE ydoc_key = ${ORPHAN}`
    expect(cand).toBeTruthy()                          // orphan was marked
    const [liveCand] = await admin`SELECT 1 FROM revision_gc_candidates WHERE ydoc_key = ${LIVE}`
    expect(liveCand).toBeUndefined()                  // live blob never marked
  })

  it('deletes the orphan only once it has been orphan past the grace window (two-stage)', async () => {
    const storage = fakeStorage()
    await storage.putObject(ORPHAN, new Uint8Array([1]), 'application/octet-stream')
    await storage.putObject(LIVE, new Uint8Array([2]), 'application/octet-stream')

    await runRevisionGc(admin, storage, { graceSeconds: 24 * 3600 })       // run 1: mark
    // Simulate grace elapsed by advancing the GC's clock past first_seen + grace.
    const future = Date.now() + 48 * 3600 * 1000
    const r2 = await runRevisionGc(admin, storage, { graceSeconds: 24 * 3600, now: future }) // run 2: delete
    expect(r2.deleted).toBe(1)
    expect(storage.objs.has(ORPHAN)).toBe(false)      // orphan reclaimed
    expect(storage.objs.has(LIVE)).toBe(true)         // live blob still safe
    const [cand] = await admin`SELECT 1 FROM revision_gc_candidates WHERE ydoc_key = ${ORPHAN}`
    expect(cand).toBeUndefined()                       // mark cleared
  })

  it('un-marks a candidate that became live again (never deletes a now-referenced blob)', async () => {
    const storage = fakeStorage()
    await storage.putObject(ORPHAN, new Uint8Array([1]), 'application/octet-stream')
    await runRevisionGc(admin, storage, { graceSeconds: 3600 })            // run 1: mark only (within grace)
    // It is now referenced by a revision row → no longer orphan.
    await admin`INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by) VALUES (${TENANT}, ${pageId}, ${ORPHAN}, 'now-live', 'user:dev-user')`
    try {
      const r = await runRevisionGc(admin, storage, { graceSeconds: 3600, now: Date.now() + 1e9 })
      expect(r.deleted).toBe(0)                        // not deleted: it is live now (even past grace)
      expect(storage.objs.has(ORPHAN)).toBe(true)      // referenced blob preserved
      const [cand] = await admin`SELECT 1 FROM revision_gc_candidates WHERE ydoc_key = ${ORPHAN}`
      expect(cand).toBeUndefined()                      // un-marked
    } finally {
      await admin`DELETE FROM revisions WHERE ydoc_key = ${ORPHAN}`
    }
  })
})
