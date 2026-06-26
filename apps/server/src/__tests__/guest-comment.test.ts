// #100 / ADR-029: guest (share-link) commenting via the HTTP API. Real Postgres + OpenFGA +
// Fastify. A comment-link guest can create/list/reply; a view-link guest cannot comment; the
// guest author is a "guest:<id>" LABEL (never a member sub); the member-only @mention
// directory is unreachable by guests.
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
const CLINK = 'gc-comment-link'
const VLINK = 'gc-view-link'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let app: FastifyInstance
let commentTok: string
let viewTok: string
const tuples = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
  { user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` },
  { user: `share_link:${VLINK}`, relation: 'view', object: `page:${PAGE}` },
]
const H = (tok: string) => ({ host: 'dev.localhost', authorization: `Bearer ${tok}` })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Guest Comment Space') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${PAGE}, ${TENANT}, ${SPACE}, 'Guest Comment Page') ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, tuples)
  const res = { type: 'page', id: PAGE } as const
  commentTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: CLINK, resource: res, capability: 'comment' })
  viewTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: VLINK, resource: res, capability: 'view' })
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, tuples).catch(() => {})
  await admin`DELETE FROM comments WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM comment_threads WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${PAGE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#100 guest commenting', () => {
  it('a comment-link guest creates a thread; the author is a guest label, not a member', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(commentTok), payload: { body: 'hello from a guest' } })
    expect(create.statusCode).toBe(201)

    const list = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(commentTok) })
    expect(list.statusCode).toBe(200)
    const body = list.json() as { threads: { comments: { body: string; authorSub: string }[] }[] }
    const c = body.threads.flatMap((t) => t.comments).find((c) => c.body === 'hello from a guest')!
    expect(c.authorSub).toBe(`guest:${CLINK}`) // a label — never a member sub (sum-type integrity)
    expect(c.authorSub.startsWith('user:')).toBe(false)
  })

  it('a comment-link guest can reply to a thread', async () => {
    const create = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(commentTok), payload: { body: 'root' } })
    const { threadId } = create.json() as { threadId: string }
    const reply = await app.inject({ method: 'POST', url: `/comments/threads/${threadId}/comments`, headers: H(commentTok), payload: { body: 'a guest reply' } })
    expect(reply.statusCode).toBe(201)
  })

  it('a VIEW-link guest CANNOT comment (capability gate)', async () => {
    const res = await app.inject({ method: 'POST', url: `/pages/${PAGE}/comments`, headers: H(viewTok), payload: { body: 'should fail' } })
    expect(res.statusCode).toBe(401) // a view token is rejected on a comment route
  })

  it('a VIEW-link guest CAN list comments (viewers see comments)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: H(viewTok) })
    expect(res.statusCode).toBe(200)
  })

  it('a guest CANNOT reach the member @mention directory', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PAGE}/mentionable`, headers: H(commentTok) })
    expect(res.statusCode).toBe(401) // member-only route — no guest config
  })

  it('a guest comment-token for THIS page cannot comment on another page (page-bound)', async () => {
    const res = await app.inject({ method: 'POST', url: `/pages/some-other-page/comments`, headers: H(commentTok), payload: { body: 'x' } })
    expect(res.statusCode).toBe(403) // token resource is bound to PAGE
  })
})
