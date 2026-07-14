// #308 / ADR-132: content-import integration — real Postgres + OpenFGA + storage. Exports a small source tree,
// then imports the ZIP into a fresh destination space and asserts the round-trip (tree, exact titles, remapped
// internal links + re-uploaded attachments), the authz gate (non-editor refused; MEMBER-only), and draft-first.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, check } from '@wikistead/authz'
import { LogicalStorageDriver } from '../storage/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { buildExport } from '../export/index.js'
import { importArchive } from '../import/index.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const storage = new LogicalStorageDriver()
const driver = new LogicalSearchDriver()
const deps = { db: null as unknown as TenantDb, fga: fgaClient, storage, driver }
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let db: TenantDb
const SRC_SPACE = 'imp-src-space'
const ROOT = 'imp-root', CHILD = 'imp-child'
const ATT = 'imp-att'
const USER = 'dev-user' // the executor: creates the destination space (→ manage → edit) and can view the source

const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const grants = [
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${ROOT}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${CHILD}` },
]

async function putObject(key: string) {
  const url = await storage.presignPut(key, { contentType: 'image/png', ttlSeconds: 300 })
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG })
  if (!r.ok) throw new Error(`PUT ${r.status}`)
}

beforeAll(async () => {
  await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  deps.db = db
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SRC_SPACE}, ${TENANT}, 'Import Src') ON CONFLICT (id) DO NOTHING`
  // Root links to Child via /p/<id> AND embeds an attachment — both must round-trip with NEW ids.
  const rootBody = `# Root\n\nsee [child](/p/${CHILD})\n\n![pic](wks-attachment:${ATT})\n`
  const childBody = '## Child body'
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, ydoc, published_md, published_at) VALUES
    (${ROOT},  ${TENANT}, ${SRC_SPACE}, NULL,    'Root Doc',  ${ydoc(rootBody)},  ${rootBody},  now()),
    (${CHILD}, ${TENANT}, ${SRC_SPACE}, ${ROOT}, 'Child Doc', ${ydoc(childBody)}, ${childBody}, now())
    ON CONFLICT (id) DO NOTHING`
  const k = `${TENANT}/imp/${ATT}.png`
  await putObject(k)
  await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status, size_bytes, confirmed_at) VALUES
    (${ATT}, ${TENANT}, ${ROOT}, 'pic.png', 'image/png', ${k}, 'confirmed', ${PNG.length}, now())
    ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, grants)
})

afterAll(async () => {
  await deleteTuples(fgaClient, grants).catch(() => {})
  await admin`DELETE FROM attachments WHERE tenant_id = ${TENANT} AND id LIKE 'imp-att%'`.catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${ROOT}, ${CHILD})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SRC_SPACE}`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
})

async function exportZip(): Promise<Uint8Array> {
  const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: ROOT })
  expect(res!.filename).toMatch(/\.zip$/)
  return res!.body
}

describe('importArchive round-trip (#308 / ADR-132)', () => {
  it('imports the exported tree into a new space with NEW ids, remapped links, re-uploaded attachments, as DRAFTS', async () => {
    const zip = await exportZip()
    const dest = await createSpace(db, fgaClient, { tenantId: TENANT, userId: USER, plan: 'free', name: 'Import Dest' })
    try {
      const report = await importArchive(deps, zip, { tenantId: TENANT, spaceId: dest.id, userId: USER, plan: 'free' })
      expect(report.pagesCreated).toBe(2)
      expect(report.attachmentsImported).toBe(1)
      expect(report.lossyTitles).toBe(false) // manifest present → exact titles
      expect(report.published).toBe(0) // draft-first

      const rows = await db.sql<{ id: string; title: string; parent_id: string | null; published_md: string | null; ydoc: Buffer | null }[]>`
        SELECT id, title, parent_id, published_md, ydoc FROM pages WHERE space_id = ${dest.id} ORDER BY title`
      expect(rows.map((r) => r.title)).toEqual(['Child Doc', 'Root Doc']) // exact titles preserved
      const root = rows.find((r) => r.title === 'Root Doc')!
      const child = rows.find((r) => r.title === 'Child Doc')!
      // NEW ids (never the source ids) and the tree shape reproduced.
      expect(root.id).not.toBe(ROOT)
      expect(child.parent_id).toBe(root.id)
      // draft-first: no published snapshot.
      expect(root.published_md).toBeNull()

      // the draft body (Y.Text 'content') has the internal link remapped to the NEW child id and the image
      // rewritten to a NEW wks-attachment id (never the source ids).
      const body = (() => { const d = new Y.Doc(); Y.applyUpdate(d, new Uint8Array(root.ydoc!)); return d.getText('content').toString() })()
      expect(body).toContain(`/p/${child.id}`)
      expect(body).not.toContain(`/p/${CHILD}`)
      expect(body).toMatch(/wks-attachment:[a-f0-9-]+/)
      expect(body).not.toContain(ATT)

      // the re-uploaded attachment is a NEW confirmed row on the new root page.
      const atts = await db.sql<{ id: string; page_id: string; status: string }[]>`
        SELECT id, page_id, status FROM attachments WHERE page_id = ${root.id}`
      expect(atts.length).toBe(1)
      expect(atts[0]!.status).toBe('confirmed')
      expect(atts[0]!.id).not.toBe(ATT)
    } finally {
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: dest.id, userId: USER }).catch(() => {})
    }
  })

  it('publish:true bulk-publishes the imported pages', async () => {
    const zip = await exportZip()
    const dest = await createSpace(db, fgaClient, { tenantId: TENANT, userId: USER, plan: 'free', name: 'Import Dest Pub' })
    try {
      const report = await importArchive(deps, zip, { tenantId: TENANT, spaceId: dest.id, userId: USER, plan: 'free', publish: true })
      expect(report.published).toBe(2)
      const rows = await db.sql<{ published_md: string | null }[]>`SELECT published_md FROM pages WHERE space_id = ${dest.id}`
      expect(rows.every((r) => r.published_md != null)).toBe(true)
    } finally {
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: dest.id, userId: USER }).catch(() => {})
    }
  })

  it('AUTHZ: a non-editor executor is refused (403) and creates NOTHING (compensating rollback)', async () => {
    const zip = await exportZip()
    // A space the executor does NOT edit: created by dev-user, but we import as a different, ungranted user.
    const dest = await createSpace(db, fgaClient, { tenantId: TENANT, userId: USER, plan: 'free', name: 'Import Dest Denied' })
    try {
      await expect(importArchive(deps, zip, { tenantId: TENANT, spaceId: dest.id, userId: 'stranger-xyz', plan: 'free' }))
        .rejects.toMatchObject({ statusCode: 403 })
      // nothing was created in the destination by the failed import.
      const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM pages WHERE space_id = ${dest.id}`
      expect(n).toBe(0)
    } finally {
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: dest.id, userId: USER }).catch(() => {})
    }
  })

  it('AUTHZ: imported pages are creator-only DRAFTS — a space viewer does NOT inherit them (no page#space)', async () => {
    const zip = await exportZip()
    const dest = await createSpace(db, fgaClient, { tenantId: TENANT, userId: USER, plan: 'free', name: 'Import Dest Draft' })
    const viewerGrant = [{ user: 'user:audience-xyz', relation: 'viewer', object: `space:${dest.id}` }]
    await writeTuples(fgaClient, viewerGrant)
    try {
      await importArchive(deps, zip, { tenantId: TENANT, spaceId: dest.id, userId: USER, plan: 'free' })
      const rows = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE space_id = ${dest.id}`
      expect(rows.length).toBe(2)
      // A space VIEWER cannot view an imported page: createPage did NOT wire page#space for the draft, so the
      // `viewer from space` inheritance does not reach it. The executor keeps their creator-manage view.
      for (const r of rows) {
        expect(await check(fgaClient, 'user:audience-xyz', 'view', { type: 'page', id: r.id })).toBe(false)
        expect(await check(fgaClient, `user:${USER}`, 'view', { type: 'page', id: r.id })).toBe(true)
      }
    } finally {
      await deleteTuples(fgaClient, viewerGrant).catch(() => {})
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: dest.id, userId: USER }).catch(() => {})
    }
  })
})
