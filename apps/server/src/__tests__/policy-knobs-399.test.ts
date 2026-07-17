// #399 / ADR-158: the permission-policy knobs. Anti-test matrix (binding conditions):
// - space creation (#445 / ADR-171 SUPERSEDED the §2 binary knob): the tenant#space_creator
//   wildcard absent → member create 403 (static reason), admin succeeds (`or admin`), the PERSONAL
//   auto-create stays exempt; wildcard present = today's default behaviour.
// - page_creation_policy='managers': an EDITOR's create 403s IDENTICALLY through every createPage
//   entry form (plain / duplicate fromPageId / templateId) — the chokepoint pin (import/MCP call the
//   same function;verified the call graph); a manager succeeds; the knob never grants.
// - page comment override: ADDITIVE only (a page opens what the space keeps closed; never narrows),
//   members/guests wildcards toggle independently (NOT a #244 pair).
// Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace, ensurePersonalSpace } from '../routes/spaces.js'
import { createPage, deletePage, guestCreatePublishPage } from '../routes/pages.js'
import { LogicalStorageDriver } from '../storage/index.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const EDITOR = 'pk399-editor'
const PERSONAL = 'pk399-personal'
const grants: { user: string; relation: string; object: string }[] = []
const pages: string[] = []

// #445 / ADR-171: the space-creation control IS the tenant#space_creator wildcard tuple now.
const wildcard = () => ({ user: 'user:*', relation: 'space_creator', object: `tenant:${tenant.id}` })
const setMembersMayCreate = async (on: boolean) => {
  if (on) await writeTuples(fgaClient, [wildcard()]).catch(() => {}) // idempotent (already-exists)
  else await deleteTuples(fgaClient, [wildcard()]).catch(() => {}) // idempotent (may be absent)
}
const setPagePolicy = (v: string) => admin`UPDATE spaces SET page_creation_policy = ${v} WHERE id = ${spaceId}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'pk399' })).id
  grants.push({ user: `user:${EDITOR}`, relation: 'editor_member', object: `space:${spaceId}` })
  await writeTuples(fgaClient, grants)
}, 60_000)

afterAll(async () => {
  await setMembersMayCreate(true)
  await deleteTuples(fgaClient, grants).catch(() => {})
  for (const id of pages) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM spaces WHERE personal_owner_sub = ${PERSONAL}`
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('space creation via tenant#space_creator (#445 / ADR-171 — supersedes #399 §2)', () => {
  it('wildcard ABSENT: a plain member is 403 with the static reason; the admin succeeds (`or admin`); personal auto-create stays exempt', async () => {
    await setMembersMayCreate(false)
    try {
      await expect(createSpace(db, fgaClient, { tenantId: tenant.id, userId: EDITOR, plan: tenant.plan, name: 'blocked' }))
        .rejects.toMatchObject({ statusCode: 403, reason: 'space_creator' })
      // dev-user is tenant admin → allowed via the model's `or admin` arm.
      const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'admin-ok' })
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: s.id, userId: 'dev-user' })
      // The PERSONAL auto-create is a resource kind, not a privilege — a plain member still gets one.
      await ensurePersonalSpace(db, fgaClient, { tenantId: tenant.id, userId: PERSONAL, name: 'P', plan: tenant.plan })
      const [row] = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE personal_owner_sub = ${PERSONAL}`
      expect(row).toBeDefined()
    } finally {
      await setMembersMayCreate(true)
    }
  })

  it("wildcard PRESENT (the seeded default): a plain member can create (today's behaviour, non-regression)", async () => {
    await setMembersMayCreate(true)
    const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: EDITOR, plan: tenant.plan, name: 'member-ok' })
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: s.id, userId: EDITOR })
  })

  it('cross-tenant: the dev wildcard never lets a member create in ANOTHER tenant (acme has its own tuple set)', async () => {
    // The acme tenant's wildcard is its own tuple; deleting IT must not affect dev, and the dev
    // member must not create into acme (tenant object binds the check).
    const acme = { user: 'user:*', relation: 'space_creator', object: 'tenant:tenant_acme' }
    await deleteTuples(fgaClient, [acme]).catch(() => {})
    try {
      await expect(createSpace(db, fgaClient, { tenantId: 'tenant_acme', userId: EDITOR, plan: tenant.plan, name: 'x-tenant' }))
        .rejects.toMatchObject({ statusCode: 403 })
      // dev unaffected by acme's missing wildcard
      const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: EDITOR, plan: tenant.plan, name: 'dev-still-ok' })
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: s.id, userId: EDITOR })
    } finally {
      await writeTuples(fgaClient, [acme]).catch(() => {})
    }
  })
})

describe('page_creation_policy (#399 §3 — the chokepoint pin)', () => {
  it("'managers': the editor 403s IDENTICALLY via plain create, duplicate, and template (one gate inside createPage); the manager succeeds", async () => {
    const seed = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'seed' })
    pages.push(seed.id)
    await admin`UPDATE pages SET published_md = 'seed body', published_at = now() WHERE id = ${seed.id}`
    await setPagePolicy('managers')
    try {
      const expect403 = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403, reason: 'page_creation_policy' })
      await expect403(createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, title: 'plain' }))
      await expect403(createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, title: 'dup', fromPageId: seed.id }))
      await expect403(createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, title: 'tpl', templateId: 'no-such-template' }))
      // The manager (space creator) passes every form.
      const ok = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'mgr ok' })
      pages.push(ok.id)
    } finally {
      await setPagePolicy('editors')
    }
  })

  it("'managers' closes the GUEST create route too (a space edit share-link is a live create path; a guest is never a manager)", async () => {
    // Reviewer finding on ADR-158's stale premise: #274/ADR-135 shipped space edit share-links, so
    // guestCreatePublishPage is a real "by any means" entry — it must hit the same knob.
    const storage = new LogicalStorageDriver()
    const elink = { user: 'share_link:pk399-elink', relation: 'editor', object: `space:${spaceId}` }
    await writeTuples(fgaClient, [elink])
    await setPagePolicy('managers')
    try {
      await expect(guestCreatePublishPage(db, fgaClient, driver, storage, { tenantId: tenant.id, spaceId, shareLinkId: 'pk399-elink', title: 'guest blocked' }))
        .rejects.toMatchObject({ statusCode: 403, reason: 'page_creation_policy' })
      // Default 'editors': the guest path itself stays intact (non-regression).
      await setPagePolicy('editors')
      const g = await guestCreatePublishPage(db, fgaClient, driver, storage, { tenantId: tenant.id, spaceId, shareLinkId: 'pk399-elink', title: 'guest ok' })
      pages.push(g.id)
    } finally {
      await setPagePolicy('editors')
      await deleteTuples(fgaClient, [elink]).catch(() => {})
    }
  })

  it("default 'editors': the editor creates as today (non-regression); a NON-member stays denied in every knob state (knobs never grant)", async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, title: 'editor ok' })
    pages.push(p.id)
    await setPagePolicy('managers')
    try {
      await expect(createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'pk399-outsider', title: 'nope' }))
        .rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await setPagePolicy('editors')
    }
    await expect(createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'pk399-outsider', title: 'nope' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('page comment-audience override (#399 §1 — additive, independent wildcards)', () => {
  it('a page OPENS guest comments its space keeps closed; the wildcards toggle independently; space-open cannot be narrowed', async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'audience' })
    pages.push(p.id)
    // Guest needs view to comment (comment = ... or (view_base AND comment_open)); grant a view link.
    const guest = { user: 'share_link:pk399-link', relation: 'view_direct', object: `page:${p.id}` }
    await writeTuples(fgaClient, [guest])
    try {
      // Space closed (default), page closed → guest cannot comment.
      expect(await check(fgaClient, 'share_link:pk399-link', 'comment', { type: 'page', id: p.id })).toBe(false)
      // PAGE opens guests only (share_link:* alone — independent wildcard, not a pair).
      await writeTuples(fgaClient, [{ user: 'share_link:*', relation: 'comment_open', object: `page:${p.id}` }])
      expect(await check(fgaClient, 'share_link:pk399-link', 'comment', { type: 'page', id: p.id })).toBe(true)
      // Members stayed closed on this page (user:* not written): a viewer member has no comment path
      // beyond editors/explicit grants — the members wildcard is genuinely independent.
      expect(await checkRelation(fgaClient, 'user:*', 'comment_open', { type: 'page', id: p.id })).toBe(false)
      // ADDITIVE pin: with the SPACE open for guests, deleting the page tuple does NOT close the page
      // (comment_open = own or from space — a page can never narrow below its space). Space inheritance
      // rides the page#space link, which publish writes — write it here (the test page is a draft).
      await deleteTuples(fgaClient, [{ user: 'share_link:*', relation: 'comment_open', object: `page:${p.id}` }])
      const spaceLink = { user: `space:${spaceId}`, relation: 'space', object: `page:${p.id}` }
      await writeTuples(fgaClient, [spaceLink, { user: 'share_link:*', relation: 'comment_open', object: `space:${spaceId}` }])
      try {
        expect(await check(fgaClient, 'share_link:pk399-link', 'comment', { type: 'page', id: p.id })).toBe(true)
      } finally {
        await deleteTuples(fgaClient, [spaceLink, { user: 'share_link:*', relation: 'comment_open', object: `space:${spaceId}` }])
      }
    } finally {
      await deleteTuples(fgaClient, [guest]).catch(() => {})
    }
  })
})
