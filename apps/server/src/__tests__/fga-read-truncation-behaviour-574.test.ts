// #574 review finding 2: the ticket shipped a DISCOVERY pin and no behavioural ones, so the
// six reads it actually fixed were protected by a scanner and by nothing that runs the code. The two
// worth the fixture cost are the ones that answer WRONG rather than merely short:
//
//   - the SPACE MOVE sweep decides, per page, whether that page carries the OLD `page#space` link.
//     A truncated read says "no link" for a page that has one, the swap skips it, and the page is
//     LEFT BEHIND in the old space — data placement broken, silently, for one page out of a subtree.
//   - the page's own comment-audience toggle reads its `comment_open` wildcards. Those are written
//     last, so on a page with many grants they fall off page one and the toggle draws OFF while the
//     model says ON — an admin then "turns it on" and nothing changes.
//
// Both fixtures put >50 sibling tuples on the page BEFORE the deciding tuple, which is what makes an
// unpaginated read answer wrong (the #553 shape). Verified by reverting each call site to a bare
// `fga.read({object})`: both cases go red.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, readObjectTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, movePage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceA = ''
let spaceB = ''
let movePageId = ''
let audiencePageId = ''
const noise: { user: string; relation: string; object: string }[] = []

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

// 60 per-principal siblings: more than one Read page, so anything written after them is invisible to
// a single-page read.
const siblingsFor = (pageId: string, tag: string) =>
  Array.from({ length: 60 }, (_, i) => ({ user: `user:trunc-${tag}-${i}-${STAMP}`, relation: 'view_direct', object: `page:${pageId}` }))

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceA = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `trunc-a-${STAMP}` })).id
  spaceB = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `trunc-b-${STAMP}` })).id

  movePageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: spaceA, userId: OWNER, title: `trunc-move-${STAMP}` })).id
  audiencePageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: spaceA, userId: OWNER, title: `trunc-aud-${STAMP}` })).id

  // ORDER MATTERS, and the first version of this fixture got it wrong. OpenFGA answers a Read in
  // insertion order, so a deciding tuple written BEFORE the siblings sits on page one and truncation
  // cannot hide it — the pin passed with the fix removed. The realistic shape is the other way round:
  // a DRAFT accumulates grants, and `page#space` is written when it is finally published. So the
  // siblings go on first, and the structural tuple lands last, where a single-page read loses it.
  noise.push(...siblingsFor(movePageId, 'mv'), ...siblingsFor(audiencePageId, 'aud'))
  await writeTuples(fgaClient, noise.slice(0, 60))
  await writeTuples(fgaClient, noise.slice(60))

  // publish AFTER the grants: page#space (move) and later the comment_open wildcards (audience) are
  // now the newest tuples on their pages
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: movePageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: audiencePageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, noise).catch(() => {})
  for (const id of [movePageId, audiencePageId]) {
    await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: OWNER }).catch(() => {})
  }
  for (const id of [spaceA, spaceB]) {
    await admin`DELETE FROM role_assignments WHERE resource_id = ${id}`.catch(() => {})
    await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: id, userId: OWNER }).catch(() => {})
  }
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

// The assertion side has to page too, and it must page the SAME way the product does. Writing this
// helper by hand is how this test first lied to me: it followed `continuationToken` (camelCase),
// which this SDK does not return — measured, `continuation_token` is the field, so the loop ran once
// and reported the page as having no space link at all. The product was right; the assertion was
// truncating. Use the shipped helper, which is also the thing under test.
const spaceLinksOf = async (pageId: string): Promise<string[]> =>
  (await readObjectTuples(fgaClient, `page:${pageId}`)).filter((k) => k.relation === 'space').map((k) => k.user)

describe('#574: the reads that answer WRONG when truncated', () => {
  // CONTROL: the same move on a page with NO siblings. If this loses the link too, the fixture is
  // measuring something other than truncation and the pin below would be a lie.
  it('CONTROL: a move without siblings keeps the link', async () => {
    const p = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: spaceA, userId: OWNER, title: `trunc-ctl-${STAMP}` })).id
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
    expect(await spaceLinksOf(p)).toEqual([`space:${spaceA}`])
    await movePage(db, fgaClient, app.searchDriver, { pageId: p, userId: OWNER, parentId: null, afterId: null, spaceId: spaceB })
    const links = await spaceLinksOf(p)
    await deletePage(db, fgaClient, app.searchDriver, { pageId: p, userId: OWNER }).catch(() => {})
    expect(links, 'the control must pass, or the noisy case below proves nothing').toEqual([`space:${spaceB}`])
  }, 180_000)

  it('a space move carries a page whose space link sits past the first read page', async () => {
    expect(await spaceLinksOf(movePageId), 'before: linked to A').toEqual([`space:${spaceA}`])

    await movePage(db, fgaClient, app.searchDriver, { pageId: movePageId, userId: OWNER, parentId: null, afterId: null, spaceId: spaceB })

    const links = await spaceLinksOf(movePageId)
    expect(links, 'the page moved WITH its subtree — not left behind in the old space').toEqual([`space:${spaceB}`])
    const [row] = await admin<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${movePageId}`
    expect(row!.space_id, 'and the table agrees with FGA').toBe(spaceB)
  }, 180_000)

  it('the page comment-audience toggle reads ON when the wildcards sit past the first read page', async () => {
    // turn both audiences on THROUGH the product, so the wildcards are written after the 60 siblings
    const on = await app.inject({
      method: 'PUT', url: `/pages/${audiencePageId}/comment-audience`, headers: dev,
      payload: { guests: true, members: true },
    })
    expect(on.statusCode, 'the toggle write itself succeeds').toBeLessThan(300)

    const read = await app.inject({ method: 'GET', url: `/pages/${audiencePageId}/comment-audience`, headers: dev })
    expect(read.statusCode).toBe(200)
    expect(read.json(), 'a truncated read would draw OFF while the model says ON').toMatchObject({ guests: true, members: true })
  }, 180_000)
})
