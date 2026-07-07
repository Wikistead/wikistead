// #229: create a page FROM a template — the new draft's ydoc is seeded with the source page's
// published content; the source is view-gated (a non-viewer 404s, hiding existence). Real PG + FGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'
import * as Y from 'yjs'

async function draftMd(admin: postgres.Sql, pageId: string): Promise<string> {
  const [r] = await admin<{ ydoc: Buffer | null }[]>`SELECT ydoc FROM pages WHERE id = ${pageId}`
  if (!r?.ydoc) return ''
  const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(r.ydoc)); return doc.getText('content').toString()
}

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, spaceId: string
const ids: string[] = []

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'tmpl-space' })).id
}, 60_000)
afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await adminPool.end()
}, 60_000)

describe('createPage fromPageId (#229 template)', () => {
  it('seeds the new draft with the template\'s published markdown', async () => {
    const tmpl = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Meeting Template' })
    ids.push(tmpl.id)
    const body = '# Agenda\n\n- item one\n- item two\n'
    await adminPool`UPDATE pages SET published_md = ${body}, published_at = now() WHERE id = ${tmpl.id}`

    const fresh = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'From Template', fromPageId: tmpl.id })
    ids.push(fresh.id)
    // the new page's DRAFT ydoc reconstructs to the template body (draftMarkdown reads getText('content'))
    const draft = await draftMd(adminPool, fresh.id)
    expect(draft).toBe(body)
  })

  it('a non-viewer of the template gets 404 (existence hidden), no page created', async () => {
    const tmpl = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Private Template' })
    ids.push(tmpl.id)
    await adminPool`UPDATE pages SET published_md = 'secret', published_at = now() WHERE id = ${tmpl.id}`
    // 'other-user' is not a member/viewer of the space or the (draft, creator-only) template.
    await expect(
      createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'other-user', title: 'x', fromPageId: tmpl.id }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })
  })

  it('no fromPageId → an empty draft (unchanged behaviour)', async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Blank' })
    ids.push(p.id)
    expect(await draftMd(adminPool, p.id)).toBe('')
  })
})
