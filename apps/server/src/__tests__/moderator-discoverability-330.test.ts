// #330 / ADR-141 §1b (user-approved option 1, 2026-07-15): moderator DISCOVERABILITY.
//   A: viewer_member gains `or moderator` → a pure space moderator's space appears in listAllSpaces
//      (space#view = viewer ⊇ viewer_member ⊇ moderator) and they can READ + SAVE the space's
//      templates (deliberate widening; the #258 guest boundary is untouched — moderator has no
//      share_link type).
//   B: the doc-builder space read ADDs 'moderator' (withdrawing the defer) → the space's
//      non-private published pages reach the moderator's stage-1 denorm; revoke takes them out.
// Anti-tests per the approval comment: (1) listAllSpaces shows the space, (2) the #258 template
// boundary re-pin (moderator can read/save; a share-link guest can do neither), (3) private stays
// hidden from the moderator on BOTH the view and the search face, (4) revoke removes the denorm
// entry, (5) the original moderator-330 matrix stays green (separate suite).
// Real Postgres + OpenFGA + Fastify (guest-route pin), no mocks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { provisionTenant } from '../auth/provisioning.js'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, listAllSpaces } from '../routes/spaces.js'
import { createPage, publishPage, setPagePrivate } from '../routes/pages.js'
import { saveTemplate, getTemplate } from '../routes/templates.js'
import { createShareLink } from '../routes/share-links.js'
import { buildSearchDoc } from '../search/doc-builder.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const OWNER = 'mod330b-owner'
const MOD = 'mod330b-moderator' // a PURE moderator: no member/viewer/editor grant anywhere

let app: FastifyInstance
let tenantId: string
let db: TenantDb
let spaceId: string
let pageId: string       // published, non-private
let privateId: string    // published, then made private
let templateId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  ;({ tenantId } = await provisionTenant(fgaClient, { slug: `mod330b-${Date.now().toString(36)}`, admin: { sub: OWNER } }))
  db = await acquireTenantDb(asTenant(tenantId))
  spaceId = (await createSpace(db, fgaClient, { tenantId, userId: OWNER, plan: 'free', name: 'Mod Disc' })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId, spaceId, userId: OWNER, title: 'patrol me' })).id
  privateId = (await createPage(db, fgaClient, app.searchDriver, { tenantId, spaceId, userId: OWNER, title: 'secret' })).id
  for (const id of [pageId, privateId]) {
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  }
  await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: privateId, tenantId, userId: OWNER })
  templateId = (await saveTemplate(db, fgaClient, { tenantId, userId: OWNER, fromPageId: pageId, name: 'Mod Tpl', scope: 'space', spaceId })).id
  // the appointment under test: MOD is a space moderator and NOTHING else
  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId, userId: OWNER, grantee: `user:${MOD}`, capability: 'moderate' })
}, 30_000)

afterAll(async () => {
  await admin`DELETE FROM templates WHERE id = ${templateId}`.catch(() => {})
  await admin`DELETE FROM templates WHERE tenant_id = ${tenantId}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `template:${templateId}`).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId, spaceId, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM share_links WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('#330 §1b A — the pure moderator can REACH their space', () => {
  it('listAllSpaces includes the space (capability floor = view); a stranger still sees nothing', async () => {
    const mine = await listAllSpaces(db, fgaClient, MOD)
    const row = mine.find((s) => s.id === spaceId)
    expect(row).toBeTruthy()
    expect(row!.capability).toBe('view') // moderate is not edit/manage — the view floor
    const stranger = await listAllSpaces(db, fgaClient, 'mod330b-nobody')
    expect(stranger.find((s) => s.id === spaceId)).toBeUndefined()
  })

  it('#258 template boundary re-pin: the moderator READS and SAVES space templates; a guest can do neither', async () => {
    // read
    const tpl = await getTemplate(db, fgaClient, { userId: MOD, id: templateId })
    expect(tpl?.name).toBe('Mod Tpl')
    // save (the space-scope save gate = space view, now derived from moderator)
    const saved = await saveTemplate(db, fgaClient, { tenantId, userId: MOD, fromPageId: pageId, name: 'Mod Tpl 2', scope: 'space', spaceId })
    expect(saved.id).toBeTruthy()
    await admin`DELETE FROM templates WHERE id = ${saved.id}`.catch(() => {})
    await deleteObjectTuples(fgaClient, `template:${saved.id}`).catch(() => {})

    // guest READ: template#view has no share_link path (viewer_member is member-only even with the
    // moderator branch) — pin at the FGA level against a REAL space edit link.
    const link = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceId }, capability: 'edit', expiresInSeconds: null })
    expect((await fgaClient.check({ user: `share_link:${link.id}`, relation: 'view', object: `template:${templateId}` })).allowed ?? false).toBe(false)
    // guest SAVE: the /templates route is member-only (no guest opt-in) — a guest token is 401 at the hook.
    const tok = await mintGuestToken(guestCfg, { tenantId, shareLinkId: link.id, resource: { type: 'space', id: spaceId }, capability: 'edit', anonId: 'anon:330bdisc00ab' })
    const r = await app.inject({ method: 'POST', url: '/templates', headers: { host: 'dev.localhost', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, payload: { fromPageId: pageId, name: 'nope', scope: 'space', spaceId } })
    expect(r.statusCode).toBe(401)
  })

  it('private stays hidden: the moderator (not on the allowlist) has NO view on the private page', async () => {
    expect(await check(fgaClient, `user:${MOD}`, 'view', { type: 'page', id: privateId })).toBe(false)
  })
})

describe('#330 §1b B — the search denorm follows the appointment', () => {
  it('the moderator is in the non-private published page\'s viewer set; the PRIVATE page never lists them', async () => {
    const doc = await buildSearchDoc(pool, fgaClient, pageId, tenantId)
    expect(doc?.viewerUsers).toContain(`user:${MOD}`)
    const priv = await buildSearchDoc(pool, fgaClient, privateId, tenantId)
    expect(priv?.viewerUsers ?? []).not.toContain(`user:${MOD}`)
    expect(priv?.isPublic ?? false).toBe(false)
  })

  it('revoking the moderator grant removes them from the denorm (sync revocation rule)', async () => {
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId, userId: OWNER, grantee: `user:${MOD}`, capability: 'moderate' })
    try {
      const doc = await buildSearchDoc(pool, fgaClient, pageId, tenantId)
      expect(doc?.viewerUsers ?? []).not.toContain(`user:${MOD}`)
      // and the space is gone from their list again
      expect((await listAllSpaces(db, fgaClient, MOD)).find((s) => s.id === spaceId)).toBeUndefined()
    } finally {
      await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId, userId: OWNER, grantee: `user:${MOD}`, capability: 'moderate' })
    }
  })
})
