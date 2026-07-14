// #329 / ADR-139: page FREEZE — a staged edit lock as a model-level subtraction with a manage bypass.
//
//   frozen        [user:*, share_link:*]  full lock: everyone below manage loses edit (the PAIR — the #244
//                                         typed-wildcard lesson: user:* alone never stops a share-link guest)
//   frozen_guests [share_link:*]          members-only lock: only share-link guests lose edit
//
// The markers subtract from the edit chain BELOW the manage bypass (`edit = manage or edit_unfrozen`), so a
// freeze cuts DIRECT edit grants too (an edit share-link tuple lands in edit_direct → edit_base), which a
// private-type freeze could not do. Every edit path checks `edit` (publish, checkbox, attachment, collab,
// MCP), so the model cut closes them all with no per-path code. Deliberate breadth (ADR-139): an EDIT-ONLY
// link guest holds no view_base, so a full freeze removes their view/comment too (anti-vandalism denial);
// members degrade to read-only; a view+comment-link guest keeps view+comment. Comments stay open for
// view_base holders (`view_base and comment_open` is edit-independent) — "the body is frozen, discussion
// continues".
//
// Layer 1: pure DSL matrix (synthetic tuples, real OpenFGA). Layer 2: the product write path
// (setPageFrozen/unsetPageFrozen — manage gate, pair discipline, level exclusivity, getPage exposure).
// Layer 3: HTTP end to end (freeze routes + a frozen edit-link guest is refused at publish).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { fgaClient, check, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, getPage, setPageFrozen, unsetPageFrozen } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'
import { buildApp } from '../app.js'

const SA = 'frz329-space'
const PG = 'frz329-page'     // the matrix page
const PG2 = 'frz329-scratch' // the typed-wildcard leak-guard page
const EDITOR = 'user:frz329-editor'      // space editor (edit via edit_from_space)
const MANAGER = 'user:frz329-manager'    // space manager (the bypass)
const EDITLINK = 'share_link:frz329-editlink' // EDIT-ONLY page link (edit_direct, no view_direct)
const VIEWLINK = 'share_link:frz329-viewlink' // view+comment page link (view_direct + open comments)
const RESTRLINK = 'share_link:frz329-restrlink' // edit link that is ALSO restricted (deny composition)

const page = (id: string) => ({ type: 'page' as const, id })

const base = [
  { user: `space:${SA}`, relation: 'space', object: `page:${PG}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${PG2}` },
  { user: EDITOR, relation: 'editor_member', object: `space:${SA}` },
  { user: MANAGER, relation: 'manager', object: `space:${SA}` },
  { user: EDITLINK, relation: 'edit_direct', object: `page:${PG}` },
  { user: EDITLINK, relation: 'edit_direct', object: `page:${PG2}` },
  { user: VIEWLINK, relation: 'view_direct', object: `page:${PG}` },
  // open comment audience so the view+comment guest's comment path is really exercised
  { user: 'user:*', relation: 'comment_open', object: `space:${SA}` },
  { user: 'share_link:*', relation: 'comment_open', object: `space:${SA}` },
  // the deny-composition principal: an edit link that is also restricted on PG
  { user: RESTRLINK, relation: 'edit_direct', object: `page:${PG}` },
  { user: RESTRLINK, relation: 'restricted', object: `page:${PG}` },
]
const FROZEN_PAIR = (id: string) => [
  { user: 'user:*', relation: 'frozen', object: `page:${id}` },
  { user: 'share_link:*', relation: 'frozen', object: `page:${id}` },
]
const GUESTS_MARKER = (id: string) => [{ user: 'share_link:*', relation: 'frozen_guests', object: `page:${id}` }]
const allMarkers = (id: string) => [...FROZEN_PAIR(id), ...GUESTS_MARKER(id)]

beforeAll(async () => {
  await writeTuples(fgaClient, base)
})

afterAll(async () => {
  await deleteTuples(fgaClient, base).catch(() => {})
  await deleteTuples(fgaClient, [...allMarkers(PG), ...allMarkers(PG2)]).catch(() => {})
})

const can = (user: string, relation: string, id: string) =>
  fgaClient.check({ user, relation, object: `page:${id}` }).then((r) => r.allowed ?? false)

describe('#329 freeze — DSL matrix (real OpenFGA, synthetic tuples)', () => {
  it('baseline (unfrozen): markers empty = a no-op, exactly as today', async () => {
    expect(await can(EDITOR, 'edit', PG)).toBe(true)
    expect(await can(EDITLINK, 'edit', PG)).toBe(true)
    expect(await can(EDITLINK, 'view', PG)).toBe(true) // edit ⊆ viewable via comment
    expect(await can(MANAGER, 'edit', PG)).toBe(true)
    expect(await can(VIEWLINK, 'view', PG)).toBe(true)
    expect(await can(VIEWLINK, 'comment', PG)).toBe(true)
    expect(await can(RESTRLINK, 'edit', PG)).toBe(false) // restricted denies edit independently of freeze
  })

  it('FULL lock cuts member AND guest edit — including a DIRECT edit@share_link tuple — but manage bypasses', async () => {
    await writeTuples(fgaClient, FROZEN_PAIR(PG))
    try {
      expect(await can(EDITOR, 'edit', PG)).toBe(false)   // member → read-only
      expect(await can(EDITOR, 'view', PG)).toBe(true)    // …but view survives (space viewer path)
      expect(await can(EDITLINK, 'edit', PG)).toBe(false) // the direct share-link edit tuple is cut
      expect(await can(MANAGER, 'edit', PG)).toBe(true)   // the role bypass
      expect(await can(MANAGER, 'view', PG)).toBe(true)
    } finally {
      await deleteTuples(fgaClient, FROZEN_PAIR(PG))
    }
  })

  it('FULL lock: an EDIT-ONLY-link guest loses view/comment too (deliberate); a view+comment guest keeps both', async () => {
    await writeTuples(fgaClient, FROZEN_PAIR(PG))
    try {
      // no view_base tuple → nothing survives for the edit-only link (the intentional anti-vandalism denial)
      expect(await can(EDITLINK, 'view', PG)).toBe(false)
      expect(await can(EDITLINK, 'comment', PG)).toBe(false)
      // the view+comment link holds view_direct → view AND comment survive (edit-independent path)
      expect(await can(VIEWLINK, 'view', PG)).toBe(true)
      expect(await can(VIEWLINK, 'comment', PG)).toBe(true)
      // a member keeps commenting too (view_base and comment_open)
      expect(await can(EDITOR, 'comment', PG)).toBe(true)
    } finally {
      await deleteTuples(fgaClient, FROZEN_PAIR(PG))
    }
  })

  it('MEMBERS-ONLY lock (frozen_guests): members still edit, share-link guests do not', async () => {
    await writeTuples(fgaClient, GUESTS_MARKER(PG))
    try {
      expect(await can(EDITOR, 'edit', PG)).toBe(true)
      expect(await can(EDITLINK, 'edit', PG)).toBe(false)
      expect(await can(MANAGER, 'edit', PG)).toBe(true)
      expect(await can(EDITLINK, 'view', PG)).toBe(false) // edit-only link: view rode on edit → gone here too
    } finally {
      await deleteTuples(fgaClient, GUESTS_MARKER(PG))
    }
  })

  it('composes with restricted: the restricted principal stays denied frozen AND unfrozen', async () => {
    expect(await can(RESTRLINK, 'edit', PG)).toBe(false)
    await writeTuples(fgaClient, FROZEN_PAIR(PG))
    try {
      expect(await can(RESTRLINK, 'edit', PG)).toBe(false)
      expect(await can(RESTRLINK, 'view', PG)).toBe(false) // restricted beats view for everyone (asymmetry lives on edit only)
    } finally {
      await deleteTuples(fgaClient, FROZEN_PAIR(PG))
    }
    expect(await can(RESTRLINK, 'edit', PG)).toBe(false)
  })

  it('typed-wildcard leak guard: user:* alone does NOT stop a share-link guest; the pair does (silent-revert pin)', async () => {
    // Legacy / half-written state — only the user:* half. The typed wildcard misses share_link principals.
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'frozen', object: `page:${PG2}` }])
    expect(await can(EDITLINK, 'edit', PG2)).toBe(true) // ← the leak a lone user:* would ship
    await writeTuples(fgaClient, [{ user: 'share_link:*', relation: 'frozen', object: `page:${PG2}` }])
    expect(await can(EDITLINK, 'edit', PG2)).toBe(false) // the pair closes it
    await deleteTuples(fgaClient, FROZEN_PAIR(PG2))
    expect(await can(EDITLINK, 'edit', PG2)).toBe(true) // unfreeze restores
  })
})

// ── Layer 2 + 3: product write path + HTTP ──────────────────────────────────────────────────────────
describe('#329 freeze — write path + HTTP (real PG + OpenFGA + Fastify)', () => {
  const driver = new LogicalSearchDriver()
  let app: FastifyInstance
  let tenant: Tenant
  let db: TenantDb
  let spaceId: string
  let pageId: string
  const GUEST_LINK = 'frz329-httplink'
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }
  let guestAuth = ''
  const devH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    const registry = new TenantRegistry(pool)
    tenant = (await registry.findBySlug('dev'))!
    db = await acquireTenantDb(tenant)
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'frz329-http-space' })
    spaceId = space.id
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Freeze me' })
    pageId = p.id
    // an EDIT share link on the page (what share-links.ts relationForResource writes for capability=edit)
    await writeTuples(fgaClient, [{ user: `share_link:${GUEST_LINK}`, relation: 'edit_direct', object: `page:${pageId}` }])
    const tok = await mintGuestToken(guestCfg, { tenantId: tenant.id, shareLinkId: GUEST_LINK, resource: { type: 'page', id: pageId }, capability: 'edit' })
    guestAuth = `Bearer ${tok}`
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, [{ user: `share_link:${GUEST_LINK}`, relation: 'edit_direct', object: `page:${pageId}` }]).catch(() => {})
    await deleteTuples(fgaClient, allMarkers(pageId)).catch(() => {})
    await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
    await db.release()
    await app.close()
    await pool.end()
  }, 60_000)

  it('setPageFrozen writes the FULL pair; switching to guests clears it (level exclusivity); unfreeze clears all', async () => {
    await setPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'dev-user', level: 'full' })
    expect(await checkRelation(fgaClient, 'user:__frz__', 'frozen', page(pageId))).toBe(true)
    expect(await checkRelation(fgaClient, 'share_link:__frz__', 'frozen', page(pageId))).toBe(true) // the PAIR
    // switching levels: the new level lands, the old one is cleared (at most one level at a time)
    await setPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'dev-user', level: 'guests' })
    expect(await checkRelation(fgaClient, 'user:__frz__', 'frozen', page(pageId))).toBe(false)
    expect(await checkRelation(fgaClient, 'share_link:__frz__', 'frozen_guests', page(pageId))).toBe(true)
    // idempotent re-set at the same level
    await setPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'dev-user', level: 'guests' })
    // getPage exposes the level to a viewer
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).frozen).toBe('guests')
    await unsetPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'dev-user' })
    expect(await checkRelation(fgaClient, 'share_link:__frz__', 'frozen_guests', page(pageId))).toBe(false)
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).frozen).toBe(null)
  })

  it('freeze/unfreeze is manage-gated (403 for a non-manager)', async () => {
    await expect(setPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'frz329-nobody', level: 'full' }))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(unsetPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: 'frz329-nobody' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('HTTP: POST validates the level; freeze → the edit-link guest is refused at publish; unfreeze restores', async () => {
    const bad = await app.inject({ method: 'POST', url: `/pages/${pageId}/freeze`, headers: devH, payload: { level: 'nope' } })
    expect(bad.statusCode).toBe(400)

    const frz = await app.inject({ method: 'POST', url: `/pages/${pageId}/freeze`, headers: devH, payload: { level: 'full' } })
    expect(frz.statusCode).toBe(204)
    // the page payload carries the level (badge + dialog read this); the manager still holds edit (bypass)
    const meta = await app.inject({ method: 'GET', url: `/pages/${pageId}`, headers: devH })
    expect(meta.json().frozen).toBe('full')
    expect(meta.json().capability).toBe('edit')

    // every edit path funnels through check(edit) — publish (guest-wired) refuses the frozen edit-link guest
    const deniedPublish = await app.inject({ method: 'POST', url: `/pages/${pageId}/publish`, headers: { host: 'dev.localhost', authorization: guestAuth } })
    expect(deniedPublish.statusCode).toBe(403)

    const unfrz = await app.inject({ method: 'DELETE', url: `/pages/${pageId}/freeze`, headers: devH })
    expect(unfrz.statusCode).toBe(204)
    const restoredPublish = await app.inject({ method: 'POST', url: `/pages/${pageId}/publish`, headers: { host: 'dev.localhost', authorization: guestAuth } })
    expect(restoredPublish.statusCode).not.toBe(403) // authz restored (any non-authz outcome is fine here)
  })
})
