// #553 / ADR-199 §1 §5(i) (T3): the model swap's anti-tests — authz-critical, written BEFORE the
// model edit and run against the OLD model to MEASURE the pre-change ALLOWs (the flips below were all
// red pre-swap; the procedure the ADR mandates). Post-swap:
//   - bare `edit` (page-direct, space grant/role tuples, group subject) no longer implies comment;
//   - the manage/moderate bypass survives, restricted or not;
//   - `restricted` subtracts from every comment arm (comment_direct, space commenter, audience);
//   - the audience arm reaches edit-link guests when comment_open is ON (§5(i)) — and freeze still
//     silences them; a member commenter keeps comment+view on a frozen page (the freeze delta);
//   - an edit-only principal keeps `view` on an unfrozen page; comment-only means comment, not edit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPageFrozen } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''      // the ordinary published page
let frozenId = ''    // a published page frozen at 'full'

const P_EDIT = `user:ci-pedit-${STAMP}`     // page edit_direct
const G_EDIT = `group:ci-g-${STAMP}#member` // group subject on page edit_direct
const S_EDIT = `user:ci-sedit-${STAMP}`     // space editor_member (a bare-edit role's tuples)
const R_CMT = `user:ci-rcmt-${STAMP}`       // comment_direct + restricted
const R_AUD = `user:ci-raud-${STAMP}`       // view_direct + audience toggle + restricted
const R_MOD = `user:ci-rmod-${STAMP}`       // page moderate + restricted (bypass survivor)
const F_CMT = `user:ci-fcmt-${STAMP}`       // space commenter, checks on the FROZEN page
const C_ONLY = `user:ci-conly-${STAMP}`     // comment_direct only
const GUEST = `share_link:ci-guest-${STAMP}` // edit-link guest (page edit_direct)

let fixture: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `ci-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `ci-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  frozenId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `ci-frozen-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: frozenId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  await setPageFrozen(db, fgaClient, { pageId: frozenId, tenantId: TENANT, userId: OWNER, level: 'full', plan: 'business' })

  fixture = [
    { user: P_EDIT, relation: 'edit_direct', object: `page:${pageId}` },
    { user: G_EDIT, relation: 'edit_direct', object: `page:${pageId}` },
    { user: S_EDIT, relation: 'editor_member', object: `space:${spaceId}` },
    { user: R_CMT, relation: 'comment_direct', object: `page:${pageId}` },
    { user: R_CMT, relation: 'restricted', object: `page:${pageId}` },
    { user: R_AUD, relation: 'view_direct', object: `page:${pageId}` },
    { user: R_AUD, relation: 'restricted', object: `page:${pageId}` },
    { user: R_MOD, relation: 'moderate', object: `page:${pageId}` },
    { user: R_MOD, relation: 'restricted', object: `page:${pageId}` },
    { user: F_CMT, relation: 'commenter', object: `space:${spaceId}` },
    { user: C_ONLY, relation: 'comment_direct', object: `page:${pageId}` },
    { user: GUEST, relation: 'edit_direct', object: `page:${pageId}` },
  ]
  await writeTuples(fgaClient, fixture)
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, fixture).catch(() => {})
  await commentOpen(false).catch(() => {})
  for (const p of [pageId, frozenId]) await deletePage(db, fgaClient, app.searchDriver, { pageId: p, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const AUDIENCE = [
  { user: 'user:*', relation: 'comment_open', object: '' },
  { user: 'share_link:*', relation: 'comment_open', object: '' },
]
const commentOpen = async (on: boolean) => {
  const tuples = AUDIENCE.map((t) => ({ ...t, object: `space:${spaceId}` }))
  if (on) await writeTuples(fgaClient, tuples)
  else await deleteTuples(fgaClient, tuples).catch(() => {})
}

const comment = (who: string, page = pageId) => check(fgaClient, who, 'comment', { type: 'page', id: page })
const view = (who: string, page = pageId) => check(fgaClient, who, 'view', { type: 'page', id: page })

describe('#553 T3: edit ⇒ comment is severed; the bypass, restricted, freeze and §5(i) hold', () => {
  it('bare edit no longer comments: page-direct, group subject, space edit tuples (RED pre-swap: all ALLOWED)', async () => {
    expect(await comment(P_EDIT), 'page edit_direct').toBe(false)
    expect(await comment(G_EDIT), 'group edit subject').toBe(false)
    expect(await comment(S_EDIT), 'space editor_member (a bare-edit role\'s tuples)').toBe(false)
  }, 120_000)

  it('edit-only principals keep VIEW on an unfrozen page (publish_live → viewable)', async () => {
    expect(await view(P_EDIT)).toBe(true)
    expect(await view(S_EDIT)).toBe(true)
  }, 120_000)

  it('the bypass survives: tenant admin, creator-manager, moderate — restricted or not', async () => {
    expect(await comment(`user:${OWNER}`), 'the space creator (rowless manager)').toBe(true)
    expect(await comment(R_MOD), 'restricted moderator still comments (the subtraction sits below the bypass)').toBe(true)
  }, 120_000)

  it('restricted subtracts from every comment arm (RED pre-swap: comment_direct and audience ALLOWED)', async () => {
    expect(await comment(R_CMT), 'restricted × comment_direct').toBe(false)
    await commentOpen(true)
    try {
      expect(await comment(R_AUD), 'restricted × audience toggle').toBe(false)
    } finally {
      await commentOpen(false)
    }
  }, 120_000)

  it('§5(i): the audience reaches an edit-link guest when comment_open is ON — and only then', async () => {
    expect(await comment(GUEST), 'toggle OFF → no guest comment (RED pre-swap: ALLOWED via edit_live)').toBe(false)
    await commentOpen(true)
    try {
      expect(await comment(GUEST), 'toggle ON → the edit-link guest is in the audience (the (i) ruling)').toBe(true)
    } finally {
      await commentOpen(false)
    }
  }, 120_000)

  it('freeze: a member commenter keeps comment AND view on a frozen page; the edit-link guest stays silenced', async () => {
    expect(await comment(F_CMT, frozenId), 'the freeze delta — comment carries no frozen subtraction').toBe(true)
    expect(await view(F_CMT, frozenId)).toBe(true)
    await writeTuples(fgaClient, [{ user: GUEST, relation: 'edit_direct', object: `page:${frozenId}` }])
    await commentOpen(true)
    try {
      expect(await comment(GUEST, frozenId), 'full freeze silences the edit-link guest even inside the audience').toBe(false)
    } finally {
      await commentOpen(false)
      await deleteTuples(fgaClient, [{ user: GUEST, relation: 'edit_direct', object: `page:${frozenId}` }]).catch(() => {})
    }
  }, 120_000)

  it('comment-only means comment, not edit', async () => {
    expect(await comment(C_ONLY)).toBe(true)
    expect(await check(fgaClient, C_ONLY, 'edit', { type: 'page', id: pageId })).toBe(false)
  }, 120_000)
})
