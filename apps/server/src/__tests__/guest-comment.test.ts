// #100 / ADR-029 Option B: guest commenting is a RESOURCE SETTING, not a link capability. A VIEW-link
// guest may comment ONLY when the space has comments open (comment_open@share_link:*). Real Postgres +
// OpenFGA + Fastify. Asserts: view-link guest + comments-open creates/replies/lists with a "guest:<id>"
// author LABEL; with comments CLOSED the same view guest is admitted (view token) then 403'd by the FGA
// comment check (the 401→403 shift ADR §4 flags); the member @mention directory is unreachable; the
// token is page-bound.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SPACE = 'gc-space'
const PAGE = 'gc-page'
const VLINK = 'gc-view-link'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let app: FastifyInstance
let viewTok: string
const tuples = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
  { user: `share_link:${VLINK}`, relation: 'view_base', object: `page:${PAGE}` }, // a VIEW link (view/edit only)
]
const commentOpenTuple = { user: 'share_link:*', relation: 'comment_open', object: `space:${SPACE}` }
const setCommentsOpen = (on: boolean) => (on ? writeTuples : deleteTuples)(fgaClient, [commentOpenTuple]).catch(() => {})
const H = (tok: string) => ({ host: 'dev.localhost', authorization: `Bearer ${tok}` })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Guest Comment Space') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${PAGE}, ${TENANT}, ${SPACE}, 'Guest Comment Page') ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, tuples)
  await setCommentsOpen(true) // comments open for guests by default in this suite
  viewTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: VLINK, resource: { type: 'page', id: PAGE }, capability: 'view' })
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, [...tuples, commentOpenTuple]).catch(() => {})
  await admin`DELETE FROM comments WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM comment_threads WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${PAGE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#100 guest commenting (view link + comment_open)', () => {
  it('a view-link guest (comments open) creates a thread; the author is a guest label, not a member', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'hello from a guest' } })
    expect(create.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
    const body = list.json() as { threads: { comments: { body: string; authorSub: string }[] }[] }
    const c = body.threads.flatMap((t) => t.comments).find((c) => c.body === 'hello from a guest')!
    expect(c.authorSub).toBe(`guest:${VLINK}`) // a label — never a member sub (sum-type integrity)
    expect(c.authorSub.startsWith('user:')).toBe(false)
  })

  it('a view-link guest (comments open) can reply to a thread', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'root' } })
    const { threadId } = create.json() as { threadId: string }
    const reply = await app.inject({ method: 'POST', url: `/comments/threads/${threadId}/comments`, headers: H(viewTok), payload: { body: 'a guest reply' } })
    expect(reply.statusCode).toBe(201)
  })

  // #100 (bounce, authz-critical): a view-link GUEST must NOT be able to DELETE a MEMBER's comment.
  // The device path is exactly this — a guest bearer token hitting DELETE /comments/:id — which the
  // member-vs-member delete test (comments.test.ts, cookie auth) never exercised. The guest's authorId
  // is `guest:<shareLink>`, never a member's bare sub, so the isAuthor check fails and the guest is
  // 403'd; the comment must survive (deleted_at stays NULL).
  it('a view-link guest CANNOT delete a member\'s comment (403, comment survives)', async () => {
    const [{ id: threadId }] = await admin<[{ id: string }]>`
      INSERT INTO comment_threads (tenant_id, page_id, kind, created_by)
      VALUES (${TENANT}, ${PAGE}, 'page', 'cmt-member') RETURNING id`
    const [{ id: cid }] = await admin<[{ id: string }]>`
      INSERT INTO comments (tenant_id, thread_id, body, author_sub)
      VALUES (${TENANT}, ${threadId}, 'a member wrote this', 'cmt-member') RETURNING id`

    const del = await app.inject({ method: 'DELETE', url: `/comments/${cid}`, headers: H(viewTok) })
    expect(del.statusCode).toBe(403) // guest authorId `guest:gc-view-link` ≠ author_sub `cmt-member`

    const [row] = await admin<[{ deleted_at: Date | null }]>`SELECT deleted_at FROM comments WHERE id = ${cid}`
    expect(row!.deleted_at).toBeNull() // the member's comment was NOT deleted
  })

  it('a view-link guest CAN delete its OWN comment (positive control — authorId matches)', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'guest owns this' } })
    const { threadId } = create.json() as { threadId: string }
    const list = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
    const body = list.json() as { threads: { id: string; comments: { id: string; body: string }[] }[] }
    const own = body.threads.find((t) => t.id === threadId)!.comments.find((c) => c.body === 'guest owns this')!
    const del = await app.inject({ method: 'DELETE', url: `/comments/${own.id}`, headers: H(viewTok) })
    expect(del.statusCode).toBe(204) // own comment (author_sub === guest:<link>) → allowed
  })

  it('with comments CLOSED, the same view-link guest is admitted then 403 on comment (401→403 shift, ADR §4)', async () => {
    await setCommentsOpen(false)
    try {
      const res = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'should 403' } })
      expect(res.statusCode).toBe(403) // view token admitted (guest:'view'); FGA comment check denies
      // but the guest can STILL VIEW (list) — view is unaffected by the comment toggle
      const list = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
      expect(list.statusCode).toBe(200)
    } finally {
      await setCommentsOpen(true)
    }
  })

  it('a view-link guest CAN list comments (viewers see comments regardless of the toggle)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
    expect(res.statusCode).toBe(200)
  })

  it('a guest CANNOT reach the member @mention directory', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PAGE}/mentionable`, headers: H(viewTok) })
    expect(res.statusCode).toBe(401) // member-only route — no guest config
  })

  it('a guest token for THIS page cannot comment on another page (page-bound)', async () => {
    const res = await app.inject({ method: 'POST', url: `/pages/some-other-page/comments`, headers: H(viewTok), payload: { body: 'x' } })
    expect(res.statusCode).toBe(403) // token resource is bound to PAGE
  })

  // #100 UI: the guest page reads canComment from /published to decide whether to show the composer.
  // It must track comment_open (distinct true/false) so the composer appears only when guests may post.
  it('the /published endpoint reports canComment for the guest, tracking comment_open', async () => {
    const open = await app.inject({ method: 'GET', url: `/pages/${PAGE}/published`, headers: H(viewTok) })
    expect(open.statusCode).toBe(200)
    expect((open.json() as { canComment: boolean }).canComment).toBe(true) // open → composer shows
    await setCommentsOpen(false)
    try {
      const closed = await app.inject({ method: 'GET', url: `/pages/${PAGE}/published`, headers: H(viewTok) })
      expect((closed.json() as { canComment: boolean }).canComment).toBe(false) // closed → no composer (view still 200)
    } finally {
      await setCommentsOpen(true)
    }
  })
})

// #100 bounce (authz-critical): the DELETE/PATCH routes had no page authz — a share-link guest could
// DELETE another user's comment (the route did `req.user.sub` with no ownership/FGA gate). These pin
// the fix on the REAL routes (not just the create gate): delete/edit are the fortress, hiding the UI
// button is not enough. Distinct pass/fail — the member's comment must still exist after a denied delete.
describe('#100 comment delete/edit authz — the delete route is gated (bounce regression)', () => {
  let memberCommentId = ''

  beforeAll(async () => {
    // A MEMBER (dev-user) comment, inserted directly so its author is a real member sub, not a guest.
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO comment_threads (tenant_id, page_id, kind, created_by) VALUES (${TENANT}, ${PAGE}, 'page', 'dev-user') RETURNING id`
    const [c] = await admin<{ id: string }[]>`
      INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES (${TENANT}, ${t!.id}, 'a member comment', 'dev-user') RETURNING id`
    memberCommentId = c!.id
  })

  it('a view-link guest CANNOT delete a member\'s comment (403) — and it stays undeleted', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/comments/${memberCommentId}`, headers: H(viewTok) })
    expect(res.statusCode).toBe(403) // not the author, not an admin
    const [row] = await admin<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM comments WHERE id = ${memberCommentId}`
    expect(row!.deleted_at).toBeNull() // the delete did NOT go through (the actual security assertion)
  })

  it('a view-link guest CANNOT edit a member\'s comment (403)', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/comments/${memberCommentId}`, headers: H(viewTok), payload: { body: 'hijacked' } })
    expect(res.statusCode).toBe(403)
    const [row] = await admin<{ body: string }[]>`SELECT body FROM comments WHERE id = ${memberCommentId}`
    expect(row!.body).toBe('a member comment') // unchanged
  })

  it('the delete gate holds even with comments CLOSED (a view-only guest still cannot delete)', async () => {
    await setCommentsOpen(false)
    try {
      const res = await app.inject({ method: 'DELETE', url: `/comments/${memberCommentId}`, headers: H(viewTok) })
      expect(res.statusCode).toBe(403)
    } finally {
      await setCommentsOpen(true)
    }
  })

  it('a guest CAN delete their OWN comment (author match via the share-link principal)', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'my own guest comment' } })
    expect(create.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
    const body = list.json() as { threads: { comments: { id: string; body: string }[] }[] }
    const own = body.threads.flatMap((t) => t.comments).find((c) => c.body === 'my own guest comment')!
    const del = await app.inject({ method: 'DELETE', url: `/comments/${own.id}`, headers: H(viewTok) })
    expect(del.statusCode).toBe(204) // same share-link principal == author → allowed
  })
})
