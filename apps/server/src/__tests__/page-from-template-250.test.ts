// #250 / ADR-110: create a page FROM a template snapshot. The new draft's ydoc is seeded with the
// template's frozen body and the title defaults to the template name. Authz: the destination-space `edit`
// gate runs FIRST (a non-editor 403s regardless of templateId), and the template itself is view-gated (a
// non-viewer 404s, existence-hidden — no page is created). Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { saveTemplate } from '../routes/templates.js'
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
const templateIds: string[] = []
const EDITOR = 'pft-editor' // a member with edit on the space, but NOT the owner of the personal template

// Make a personal-scope template owned by dev-user from a published source page. Returns its id + body.
async function makeTemplate(name: string, body: string): Promise<{ id: string; body: string }> {
  const src = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'src' })
  ids.push(src.id)
  await adminPool`UPDATE pages SET published_md = ${body}, published_at = now() WHERE id = ${src.id}`
  const { id } = await saveTemplate(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', fromPageId: src.id, name, scope: 'personal' })
  templateIds.push(id)
  return { id, body }
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'pft-space' })).id
  // EDITOR can edit the space (so template-authz failures surface as 404, not a space 403).
  await writeTuples(fgaClient, [{ user: `user:${EDITOR}`, relation: 'editor', object: `space:${spaceId}` }])
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${EDITOR}`, relation: 'editor', object: `space:${spaceId}` }]).catch(() => {})
  for (const t of templateIds) await fgaClient.write({ deletes: (await fgaClient.read({ object: `template:${t}` })).tuples?.map((x) => x.key!).filter(Boolean) ?? [] }).catch(() => {})
  for (const t of templateIds) await adminPool`DELETE FROM templates WHERE id = ${t}`.catch(() => {})
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await adminPool.end()
}, 60_000)

describe('createPage templateId (#250)', () => {
  it('seeds the new draft with the template body and defaults the title to the template name', async () => {
    const body = '# Sprint\n\n- [ ] plan\n- [ ] build\n'
    const tpl = await makeTemplate('Sprint Template', body)
    const fresh = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', templateId: tpl.id })
    ids.push(fresh.id)
    expect(await draftMd(adminPool, fresh.id)).toBe(body)
    expect(fresh.title).toBe('Sprint Template') // template name fills the title when none is given
  })

  it('honours an explicit title over the template name', async () => {
    const tpl = await makeTemplate('Ignored Name', 'body\n')
    const fresh = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', templateId: tpl.id, title: 'My Title' })
    ids.push(fresh.id)
    expect(fresh.title).toBe('My Title')
  })

  it('a non-viewer of the template gets 404 (existence hidden) and creates NO page', async () => {
    const tpl = await makeTemplate('Personal Only', 'secret\n')
    const before = (await adminPool<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM pages WHERE space_id = ${spaceId}`)[0].n
    // EDITOR can edit the space but is NOT the personal template's owner → template view is false.
    await expect(
      createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, templateId: tpl.id }),
    ).rejects.toMatchObject({ statusCode: 404 })
    const after = (await adminPool<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM pages WHERE space_id = ${spaceId}`)[0].n
    expect(after).toBe(before) // no page row leaked on the 404 path
  })

  it('does not bypass the destination gate: no space edit → 403 (before any template resolution)', async () => {
    const tpl = await makeTemplate('Owned By Dev', 'body\n')
    // 'stranger' has no edit on the space; the space gate must reject BEFORE the template is touched.
    await expect(
      createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'stranger', templateId: tpl.id }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('no templateId → an empty draft (unchanged behaviour)', async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
    ids.push(p.id)
    expect(await draftMd(adminPool, p.id)).toBe('')
  })
})
