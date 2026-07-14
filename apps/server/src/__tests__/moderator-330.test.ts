// #330 / ADR-141: moderator role — space#moderator + the page `moderate` verb.
//
//   space: moderator: [user, group#member] or manager        (a manager always moderates)
//   page:  moderate_from_space: moderator from space but not private   (NO private back-door — ADR-098)
//          moderate: [user, group#member] or moderate_from_space      (direct type = the ruling:
//                                                                      appointable onto a PRIVATE page)
//          edit: manage or moderate or edit_unfrozen                  (moderate joins the freeze bypass)
//
// The capability matrix this pins (review code-backed, ADR-141 anti-tests):
//   moderator CAN  : moderate, edit (incl. a FROZEN page — the bypass), freeze/unfreeze (write path), patrol
//   moderator CANNOT: manage (grants / revoke / freeze-as-manage-only ops / delete / settings)
//   private        : a space moderator NOT on the allowlist is denied EVERY verb on a private page;
//                    a DIRECT moderate grant on the private page restores moderation (and edit via the
//                    bypass) but never manage
//   guests         : share_link can never be a moderator (type-rejected)
//
// Layer 1: DSL matrix (synthetic tuples, real OpenFGA). Layer 2: product write paths (space/page grant
// vocabulary, freeze widened to moderate, patrol widened to moderate, moderate cannot grant).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace, grantSpaceAccess, listSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, getPage, grantPageAccess, listPageAccess, setPageFrozen, unsetPageFrozen } from '../routes/pages.js'
import { markPatrolled, unmarkPatrolled } from '../routes/notifications.js'
import type { Tenant } from '@wikistead/types'

const SA = 'mod330-space'
const PG = 'mod330-page'      // published, non-private
const PRIV = 'mod330-private' // published, PRIVATE (pair-marked)
const MOD = 'user:mod330-moderator'   // space moderator (not editor, not manager)
const MGR = 'user:mod330-manager'     // space manager
const ED = 'user:mod330-editor'       // plain space editor
const page = (id: string) => ({ type: 'page' as const, id })

const base = [
  { user: `space:${SA}`, relation: 'space', object: `page:${PG}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${PRIV}` },
  { user: MOD, relation: 'moderator', object: `space:${SA}` },
  { user: MGR, relation: 'manager', object: `space:${SA}` },
  { user: ED, relation: 'editor_member', object: `space:${SA}` },
  // PRIV carries the private PAIR (ADR-098/#244)
  { user: 'user:*', relation: 'private', object: `page:${PRIV}` },
  { user: 'share_link:*', relation: 'private', object: `page:${PRIV}` },
]
const FROZEN_PAIR = (id: string) => [
  { user: 'user:*', relation: 'frozen', object: `page:${id}` },
  { user: 'share_link:*', relation: 'frozen', object: `page:${id}` },
]

beforeAll(async () => {
  await writeTuples(fgaClient, base)
})

afterAll(async () => {
  await deleteTuples(fgaClient, base).catch(() => {})
  await deleteTuples(fgaClient, [...FROZEN_PAIR(PG), { user: MOD, relation: 'moderate', object: `page:${PRIV}` }]).catch(() => {})
})

const can = (user: string, relation: string, id: string) =>
  fgaClient.check({ user, relation, object: `page:${id}` }).then((r) => r.allowed ?? false)

describe('#330 moderator — DSL matrix (real OpenFGA, synthetic tuples)', () => {
  it('space moderator: moderate + edit on a normal page; NEVER manage', async () => {
    expect(await can(MOD, 'moderate', PG)).toBe(true)
    expect(await can(MOD, 'edit', PG)).toBe(true)  // via the bypass line
    expect(await can(MOD, 'view', PG)).toBe(true)  // edit ⊆ comment ⊆ viewable
    expect(await can(MOD, 'manage', PG)).toBe(false) // grants/delete/settings stay out of reach
  })

  it('manager ⊃ moderator (or manager); a plain editor holds NO moderate', async () => {
    expect(await can(MGR, 'moderate', PG)).toBe(true)
    expect(await can(ED, 'moderate', PG)).toBe(false)
  })

  it('moderate BYPASSES freeze: a moderator (and manager) edits a fully-frozen page; an editor cannot', async () => {
    await writeTuples(fgaClient, FROZEN_PAIR(PG))
    try {
      expect(await can(MOD, 'edit', PG)).toBe(true)
      expect(await can(MGR, 'edit', PG)).toBe(true)
      expect(await can(ED, 'edit', PG)).toBe(false)
    } finally {
      await deleteTuples(fgaClient, FROZEN_PAIR(PG))
    }
  })

  it('PRIVATE is NOT bypassed (the decisive case): a non-allowlisted space moderator is denied every verb', async () => {
    expect(await can(MOD, 'moderate', PRIV)).toBe(false) // moderate_from_space is private-guarded
    expect(await can(MOD, 'edit', PRIV)).toBe(false)
    expect(await can(MOD, 'view', PRIV)).toBe(false)     // no view back-door either (edit ⊆ view chain cut)
    expect(await can(MGR, 'moderate', PRIV)).toBe(false) // same for a space manager (ADR-098 parity)
  })

  it('a DIRECT moderate grant on the private page restores moderation — edit via the bypass, never manage', async () => {
    await writeTuples(fgaClient, [{ user: MOD, relation: 'moderate', object: `page:${PRIV}` }])
    try {
      expect(await can(MOD, 'moderate', PRIV)).toBe(true)
      expect(await can(MOD, 'edit', PRIV)).toBe(true)   // what moderate grants (the bypass) — by design
      expect(await can(MOD, 'manage', PRIV)).toBe(false) // the boundary that must not move
    } finally {
      await deleteTuples(fgaClient, [{ user: MOD, relation: 'moderate', object: `page:${PRIV}` }])
    }
    expect(await can(MOD, 'moderate', PRIV)).toBe(false) // revoke restores the deny
  })

  it('a guest (share_link) can never be a moderator — the type is rejected at write', async () => {
    await expect(
      writeTuples(fgaClient, [{ user: 'share_link:mod330-link', relation: 'moderator', object: `space:${SA}` }]),
    ).rejects.toThrow()
    await expect(
      writeTuples(fgaClient, [{ user: 'share_link:mod330-link', relation: 'moderate', object: `page:${PG}` }]),
    ).rejects.toThrow()
  })
})

// ── Layer 2: product write paths ────────────────────────────────────────────────────────────────────
describe('#330 moderator — product write paths (real PG + OpenFGA)', () => {
  const driver = new LogicalSearchDriver()
  let tenant: Tenant
  let db: TenantDb
  let spaceId: string
  let pageId: string
  const MODSUB = 'mod330-wp-moderator'

  beforeAll(async () => {
    const registry = new TenantRegistry(pool)
    tenant = (await registry.findBySlug('dev'))!
    db = await acquireTenantDb(tenant)
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'mod330-wp-space' })
    spaceId = space.id
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Moderate me' })
    pageId = p.id
    // createPage leaves a DRAFT with no page#space tuple (the Phase-4 visibility gate; publish writes it).
    // moderate_from_space = `moderator from space` needs that structural link — simulate the published state.
    await writeTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` }])
  }, 60_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` }]).catch(() => {})
    await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
    await db.release()
    await pool.end()
  }, 60_000)

  it('the space grant vocabulary gained `moderate` → writes space#moderator; the list surfaces it', async () => {
    await grantSpaceAccess(db, fgaClient, driver, { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee: `user:${MODSUB}`, capability: 'moderate', plan: tenant.plan })
    const grants = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: tenant.id, userId: 'dev-user' })
    expect(grants.some((g) => g.grantee === `user:${MODSUB}` && g.capability === 'moderate')).toBe(true)
    // and it resolves: the appointee moderates the space's page
    expect(await can(`user:${MODSUB}`, 'moderate', pageId)).toBe(true)
  })

  it('freeze/unfreeze now passes for a moderator (was manage-only in C-4)', async () => {
    await setPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: MODSUB, level: 'full' })
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).frozen).toBe('full')
    await unsetPageFrozen(db, fgaClient, { pageId, tenantId: tenant.id, userId: MODSUB })
    expect((await getPage(db, fgaClient, { pageId, userId: 'dev-user' })).frozen).toBe(null)
  })

  it('getPage exposes canModerate=true for the moderator, canManage=false', async () => {
    const meta = await getPage(db, fgaClient, { pageId, userId: MODSUB })
    expect(meta.canModerate).toBe(true)
    expect(meta.canManage).toBe(false)
  })

  it('a moderator CANNOT grant page access (grants stay manage-gated → 403)', async () => {
    await expect(
      grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: MODSUB, grantee: 'user:mod330-someone', relation: 'view' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('the page grant vocabulary gained `moderate` (the private-page appointment path); the list surfaces it', async () => {
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:mod330-pagemod', relation: 'moderate', plan: tenant.plan })
    const grants = await listPageAccess(fgaClient, db, { pageId, tenantId: tenant.id, userId: 'dev-user' })
    expect(grants.some((g) => g.grantee === 'user:mod330-pagemod' && g.relation === 'moderate')).toBe(true)
    expect(await can('user:mod330-pagemod', 'moderate', pageId)).toBe(true)
    expect(await can('user:mod330-pagemod', 'manage', pageId)).toBe(false)
  })

  it('patrol passes for a moderator and stays 403 for a plain member (page feed event)', async () => {
    // a synthetic feed event on the page (the patrol target); the RLS-scoped insert mirrors fanOutFeedEvent
    const [ev] = await db.sql<[{ id: string }]>`
      INSERT INTO feed_events (tenant_id, event_type, page_id, actor)
      VALUES (${tenant.id}, 'page.published', ${pageId}, 'user:dev-user') RETURNING id`
    // the space link is in place (beforeAll), so both the moderator (view via the moderate/edit chain) and a
    // plain space VIEWER (view_base_from_space) pass the patrol view gate; only the capability gate differs.
    await writeTuples(fgaClient, [{ user: 'user:mod330-member', relation: 'viewer', object: `space:${spaceId}` }])
    try {
      await markPatrolled(db, fgaClient, { tenantId: tenant.id, subject: `user:${MODSUB}`, memberSub: MODSUB, feedEventId: ev.id })
      await unmarkPatrolled(db, fgaClient, { tenantId: tenant.id, subject: `user:${MODSUB}`, feedEventId: ev.id })
      await expect(
        markPatrolled(db, fgaClient, { tenantId: tenant.id, subject: 'user:mod330-member', memberSub: 'mod330-member', feedEventId: ev.id }),
      ).rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await db.sql`DELETE FROM feed_events WHERE id = ${ev.id}`
      await deleteTuples(fgaClient, [{ user: 'user:mod330-member', relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
    }
  })
})
