// #529 / ADR-193: the space-scoped `commenter` capability. Comment access is the OR of independent
// paths, and until now only ONE of them (the page-level grant) was per-principal — there was no way to
// say "this reviewer may comment across the space". These pin the ruled behaviour against a REAL
// OpenFGA store, because the whole point is what the model resolves to, not what the code intends.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, check } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePrivate } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const OWNER = 'dev-user' //     space creator ⇒ manager
const REVIEWER = 'cmt-reviewer' // gets the space-scoped comment grant, nothing else
const STRANGER = 'cmt-stranger' // no grant at all

let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []

const mkPage = async (title: string, parentId?: string): Promise<string> => {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER, title, parentId })
  ids.push(p.id)
  return p.id
}
const publish = (pageId: string) =>
  publishPage(db, fgaClient, driver, { putObject: async () => {}, getObject: async () => Buffer.alloc(0) } as never, {
    pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}`,
  })
const canComment = (sub: string, pageId: string) => check(fgaClient, `user:${sub}`, 'comment', { type: 'page', id: pageId })
const canEdit = (sub: string, pageId: string) => check(fgaClient, `user:${sub}`, 'edit', { type: 'page', id: pageId })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OWNER, plan: tenant.plan, name: 'commenter-529' })).id
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('#529 space#commenter — the per-principal comment grant pages inherit', () => {
  it('a space commenter may COMMENT on the space pages and may NOT edit them', async () => {
    const page = await mkPage('space-grant')
    await publish(page)
    expect(await canComment(REVIEWER, page), 'no grant yet').toBe(false)

    await writeTuples(fgaClient, [{ user: `user:${REVIEWER}`, relation: 'commenter', object: `space:${spaceId}` }])
    expect(await canComment(REVIEWER, page), 'the space grant reaches the page').toBe(true)
    expect(await canEdit(REVIEWER, page), 'comment must NOT imply edit').toBe(false)
    // ruling 1: the grantee can also open the space itself (else the tree is invisible)
    expect(await check(fgaClient, `user:${REVIEWER}`, 'view', { type: 'space', id: spaceId }), 'commenter can see the space').toBe(true)
  })

  it('a PRIVATE page cuts the space-inherited comment grant (ADR-098 is not weakened)', async () => {
    const page = await mkPage('private-cut')
    await publish(page)
    expect(await canComment(REVIEWER, page)).toBe(true) // inherited
    await setPagePrivate(db, fgaClient, driver, { pageId: page, tenantId: tenant.id, userId: OWNER })
    expect(await canComment(REVIEWER, page), 'private cuts space inheritance').toBe(false)
  })

  it('the folder cascade reaches a published CHILD but never an unpublished draft (the published gate)', async () => {
    const folder = await mkPage('folder')
    const child = await mkPage('child', folder)
    const draft = await mkPage('draft-child', folder)
    await publish(folder)
    await publish(child) // `draft` stays unpublished on purpose
    const CASCADE = 'cmt-cascade'
    await writeTuples(fgaClient, [{ user: `user:${CASCADE}`, relation: 'comment_direct', object: `page:${folder}` }])
    expect(await canComment(CASCADE, folder), 'the granted folder itself').toBe(true)
    expect(await canComment(CASCADE, child), 'a PUBLISHED child inherits the grant').toBe(true)
    expect(await canComment(CASCADE, draft), 'an unpublished draft does NOT — the Phase-4 gate').toBe(false)
  })

  it('the grant paths are a real OR (direct, audience — edit is no longer one, #553), fail-closed with none', async () => {
    const page = await mkPage('three-paths')
    await publish(page)
    // 1. nobody: closed
    expect(await canComment(STRANGER, page)).toBe(false)
    // 2. the audience toggle — note it is `view_base AND comment_open`, so it opens commenting for people
    //    who can already SEE the page; it is not a grant of its own. Give the viewer path first.
    await writeTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'view_direct', object: `page:${page}` }])
    expect(await canComment(STRANGER, page), 'view alone is not comment').toBe(false)
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'comment_open', object: `space:${spaceId}` }])
    expect(await canComment(STRANGER, page), 'view + the audience toggle opens it').toBe(true)
    await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'comment_open', object: `space:${spaceId}` }])
    expect(await canComment(STRANGER, page), 'and closing it closes them again').toBe(false)
    await deleteTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'view_direct', object: `page:${page}` }])
    // 3. #553 / ADR-199 FLIP: edit no longer subsumes comment — the third path this OR used to have
    // is the thing #553 removed (its name changed with it). A bare edit grant is edit and only edit;
    // the editor NOUN delivers comment as its own explicit grant (composite-grant-553 pins that side).
    await writeTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'edit_direct', object: `page:${page}` }])
    expect(await canComment(STRANGER, page), 'bare edit does NOT comment (#553)').toBe(false)
    await deleteTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'edit_direct', object: `page:${page}` }])
    expect(await canComment(STRANGER, page), 'fail-closed once every path is gone').toBe(false)
  })

  it('a share_link principal never gains comment through the member grant (guests use the audience toggle)', async () => {
    const page = await mkPage('guest-path')
    await publish(page)
    // the space grant is typed [user, group#member] — writing a share_link there must be impossible
    await expect(
      writeTuples(fgaClient, [{ user: 'share_link:probe-529', relation: 'commenter', object: `space:${spaceId}` }]),
    ).rejects.toBeTruthy()
    // the guest path is unchanged: the audience toggle still opens commenting for view links
    await writeTuples(fgaClient, [{ user: 'share_link:*', relation: 'comment_open', object: `space:${spaceId}` }])
    expect(await check(fgaClient, 'share_link:probe-529', 'comment', { type: 'page', id: page }), 'no view grant yet').toBe(false)
    await writeTuples(fgaClient, [{ user: 'share_link:probe-529', relation: 'view_direct', object: `page:${page}` }])
    expect(await check(fgaClient, 'share_link:probe-529', 'comment', { type: 'page', id: page }), 'view link + audience = comment').toBe(true)
    await deleteTuples(fgaClient, [
      { user: 'share_link:*', relation: 'comment_open', object: `space:${spaceId}` },
      { user: 'share_link:probe-529', relation: 'view_direct', object: `page:${page}` },
    ])
  })

  it('a trashed page denies the inherited comment (the subtraction still happens exactly once)', async () => {
    const page = await mkPage('trash-path')
    await publish(page)
    expect(await canComment(REVIEWER, page)).toBe(true)
    await writeTuples(fgaClient, [
      { user: 'user:*', relation: 'trashed', object: `page:${page}` },
      { user: 'share_link:*', relation: 'trashed', object: `page:${page}` },
    ])
    expect(await canComment(REVIEWER, page), 'trashed pages deny comment').toBe(false)
    await deleteTuples(fgaClient, [
      { user: 'user:*', relation: 'trashed', object: `page:${page}` },
      { user: 'share_link:*', relation: 'trashed', object: `page:${page}` },
    ])
  })

  it('a GROUP grantee works too, not just a user', async () => {
    const page = await mkPage('group-path')
    await publish(page)
    // Unique per run: FGA rejects a duplicate tuple outright, so a group id reused across runs (or a
    // previous run that died before its cleanup) turns this into an environment failure, not a finding.
    const GRP = `grp529-${Date.now().toString(36)}`
    const MEMBER = `cmt-group-member-${Date.now().toString(36)}`
    await writeTuples(fgaClient, [
      { user: `user:${MEMBER}`, relation: 'member', object: `group:${GRP}` },
      { user: `group:${GRP}#member`, relation: 'commenter', object: `space:${spaceId}` },
    ])
    expect(await canComment(MEMBER, page), 'the group grant reaches its members').toBe(true)
    await deleteTuples(fgaClient, [
      { user: `group:${GRP}#member`, relation: 'commenter', object: `space:${spaceId}` },
      { user: `user:${MEMBER}`, relation: 'member', object: `group:${GRP}` },
    ])
  })

  it('restricted: the MODEL now denies comment too (#553 flip — deny-wins at the model, not just the route floor)', async () => {
    // ADR-193 deliberately left `restricted` out of comment (the route's view floor refused). #553 /
    // ADR-199 reverses that with the swap: `restricted` subtracts from every comment arm BELOW the
    // manage/moderate bypass, so the model and the route agree — deny-wins, no population relying on
    // a floor. (comment-independence-553 pins the bypass survivors and the audience-arm reversal.)
    const page = await mkPage('restricted-path')
    await publish(page)
    expect(await canComment(REVIEWER, page)).toBe(true)
    await writeTuples(fgaClient, [
      { user: `user:${REVIEWER}`, relation: 'restricted', object: `page:${page}` },
    ])
    expect(await check(fgaClient, `user:${REVIEWER}`, 'view', { type: 'page', id: page }), 'restricted denies VIEW').toBe(false)
    expect(await canComment(REVIEWER, page), 'the model itself denies comment now (#553)').toBe(false)
    await deleteTuples(fgaClient, [{ user: `user:${REVIEWER}`, relation: 'restricted', object: `page:${page}` }])
  })

  it('cross-space: the grant does not reach another space pages', async () => {
    const other = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OWNER, plan: tenant.plan, name: 'commenter-529-other' })).id
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: other, userId: OWNER, title: 'elsewhere' })
    ids.push(p.id)
    await publish(p.id)
    expect(await canComment(REVIEWER, p.id), 'a grant in one space stays there').toBe(false)
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: other, userId: OWNER }).catch(() => {})
  })
})
