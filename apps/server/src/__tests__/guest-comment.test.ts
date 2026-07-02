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
