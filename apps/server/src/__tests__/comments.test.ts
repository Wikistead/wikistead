// Integration tests — real Postgres + real OpenFGA + real Valkey, no mocks.
// Page-level comments (P4 1/4): the authz matrix + tenant isolation + no-leak.
// Inline anchoring, @mention, and UX land in later commits.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const TENANT = 'tenant_dev'
// A DEDICATED space + page (NOT the shared demo fixtures, which other test files
// create/delete) so nothing clobbers these rows or grants mid-suite. dev-user
// reaches the page as admin via tenant→space→page FGA inheritance.
const SPACE = 'cmt-test-space'
const PAGE = 'cmt-test-page'

let app: FastifyInstance
const sids: Record<string, string> = {}
const cookie = (who: string) => `${SESSION_COOKIE}=${sids[who]}`
const H = (who: string) => ({ host: 'dev.localhost', cookie: cookie(who) })

const grant = (sub: string, relation: string) => ({ user: `user:${sub}`, relation, object: `page:${PAGE}` })
const fgaFixture = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` }, // tenant admin ⇒ space admin ⇒ page comment/view
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
  grant('cmt-author', 'comment_direct'), // ⇒ also view (#411 / ADR-153: `comment` is computed now; writes land on the leaf)
  grant('cmt-viewer', 'view_direct'), // #218: direct view grant → view_direct leaf (view is computed)
]

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  // Own space + page (admin pool bypasses RLS for the fixture insert).
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Comments Test Space') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${PAGE}, ${TENANT}, ${SPACE}, 'Comments Test') ON CONFLICT (id) DO NOTHING`
  // Member rows (with email) for @mention resolution. cmt-outsider is a member but
  // gets NO page grant → a member who cannot view the page (the leak case).
  await admin`INSERT INTO members (tenant_id, sub, email, display_name, role) VALUES
    (${TENANT}, 'cmt-author', 'author@x.test', 'Comment Author', 'member'),
    (${TENANT}, 'cmt-viewer', 'viewer@x.test', 'Comment Viewer', 'member'),
    (${TENANT}, 'cmt-outsider', 'outsider@x.test', 'Outsider', 'member')
    ON CONFLICT (tenant_id, sub) DO NOTHING`
  for (const who of ['author', 'viewer', 'stranger', 'admin']) {
    sids[who] = await createSession(valkey, { tenantId: TENANT, sub: who === 'admin' ? 'dev-user' : `cmt-${who}`, role: who === 'admin' ? 'admin' : 'member' })
  }
  await writeTuples(fgaClient, fgaFixture)
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, fgaFixture).catch(() => {})
  await admin`DELETE FROM comments WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM comment_threads WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE 'cmt-%'`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${PAGE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin.end()
  await valkey.quit()
  await pool.end()
})

const post = (who: string, url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: H(who), payload: payload as object })
const get = (who: string, url: string) => app.inject({ method: 'GET', url, headers: H(who) })

describe('comment authz matrix', () => {
  it('a user without page view gets a uniform 404 (no leak of the page or its comments)', async () => {
    expect((await get('stranger', `/pages/${PAGE}/comments`)).statusCode).toBe(404)
    expect((await post('stranger', `/pages/${PAGE}/comments`, { body: 'hi' })).statusCode).toBe(404)
  })

  it('a viewer can read comments but cannot create them (needs comment capability)', async () => {
    expect((await get('viewer', `/pages/${PAGE}/comments`)).statusCode).toBe(200)
    expect((await post('viewer', `/pages/${PAGE}/comments`, { body: 'hi' })).statusCode).toBe(403)
  })

  // #100: getPage.canComment gates the comment COMPOSER in the UI. It must mirror the actual comment
  // capability (distinct true/false) — a comment grant/edit → true, a view-only member → false — so a
  // viewer never sees a composer that would only 403 (and the server re-checks: the 403 above proves it).
  it('getPage.canComment reflects the comment capability: commenter true, view-only false', async () => {
    const commenter = await get('author', `/pages/${PAGE}`)
    expect(commenter.statusCode).toBe(200)
    expect((commenter.json() as { canComment: boolean }).canComment).toBe(true) // comment grant → composer shown
    const viewer = await get('viewer', `/pages/${PAGE}`)
    expect(viewer.statusCode).toBe(200)
    expect((viewer.json() as { canComment: boolean }).canComment).toBe(false) // view-only → no composer
  })

  it('a commenter creates a thread; viewers and the author then see it', async () => {
    const res = await post('author', `/pages/${PAGE}/comments`, { body: 'first comment' })
    expect(res.statusCode).toBe(201)
    const list = await get('viewer', `/pages/${PAGE}/comments`)
    const threads = list.json().threads as { id: string; comments: { body: string }[] }[]
    expect(threads.some((t) => t.comments.some((c) => c.body === 'first comment'))).toBe(true)
  })
})

describe('replies, edit, delete, resolve', () => {
  let threadId: string
  let commentId: string
  beforeAll(async () => {
    const t = await post('author', `/pages/${PAGE}/comments`, { body: 'thread root' })
    threadId = t.json().threadId
    const r = await post('author', `/comments/threads/${threadId}/comments`, { body: 'a reply' })
    commentId = r.json().commentId
  })

  it('edit is author-only', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/comments/${commentId}`, headers: H('author'), payload: { body: 'edited' } })).statusCode).toBe(200)
    // even an admin cannot rewrite someone else's words
    expect((await app.inject({ method: 'PATCH', url: `/comments/${commentId}`, headers: H('admin'), payload: { body: 'nope' } })).statusCode).toBe(403)
  })

  it('delete: a non-author non-admin cannot; the author can; an admin can delete anyone', async () => {
    // viewer (not author, not admin) cannot delete the author's comment
    expect((await app.inject({ method: 'DELETE', url: `/comments/${commentId}`, headers: H('viewer') })).statusCode).toBe(403)
    // admin (dev-user) CAN delete it
    expect((await app.inject({ method: 'DELETE', url: `/comments/${commentId}`, headers: H('admin') })).statusCode).toBe(204)
    // deleted comment no longer appears
    const threads = (await get('author', `/pages/${PAGE}/comments`)).json().threads as { id: string; comments: { id: string }[] }[]
    expect(threads.find((t) => t.id === threadId)?.comments.some((c) => c.id === commentId)).toBeFalsy()
  })

  it('resolve/reopen requires comment capability; the resolver is recorded', async () => {
    expect((await post('viewer', `/comments/threads/${threadId}/resolve`)).statusCode).toBe(403) // viewer lacks comment
    expect((await post('author', `/comments/threads/${threadId}/resolve`)).statusCode).toBe(200)
    let t = (await get('author', `/pages/${PAGE}/comments`)).json().threads.find((x: { id: string }) => x.id === threadId)
    expect(t.status).toBe('resolved')
    expect(t.resolvedBy).toBe('cmt-author')
    expect((await post('author', `/comments/threads/${threadId}/reopen`)).statusCode).toBe(200)
    t = (await get('author', `/pages/${PAGE}/comments`)).json().threads.find((x: { id: string }) => x.id === threadId)
    expect(t.status).toBe('open')
  })
})

describe('tenant isolation', () => {
  it("comments on tenant_dev's page are not reachable from another tenant's host", async () => {
    // acme-user on the acme host has no view on tenant_dev's demo page → uniform 404,
    // so tenant_dev's comments never surface cross-tenant (RLS + FGA).
    const acmeSid = await createSession(valkey, { tenantId: 'tenant_acme', sub: 'acme-admin' })
    const res = await app.inject({ method: 'GET', url: `/pages/${PAGE}/comments`, headers: { host: 'acme.localhost', cookie: `${SESSION_COOKIE}=${acmeSid}` } })
    expect(res.statusCode).toBe(404)
  })
})

describe('@mention (directory scoped to page-viewers; notification best-effort)', () => {
  // #268: the isolated server-test stack runs Mailpit on a distinct host port; read it from env
  // (defaults to the dev port so a plain `docker compose up` checkout still works).
  const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://localhost:8025/api/v1'
  const clearMail = () => fetch(`${MAILPIT}/messages`, { method: 'DELETE' })
  // Returns true as soon as a message to `addr` appears; false after the window.
  async function mailedTo(addr: string, windowMs = 1500): Promise<boolean> {
    for (let i = 0; i < windowMs / 100; i++) {
      const r = await fetch(`${MAILPIT}/messages`)
      if (r.ok) {
        const body = (await r.json()) as { messages: { To: { Address: string }[] }[] }
        if (body.messages.some((m) => m.To.some((t) => t.Address === addr))) return true
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    return false
  }

  it('directory = members who can VIEW the page, exposing ONLY sub + displayName', async () => {
    const res = await get('author', `/pages/${PAGE}/mentionable`)
    expect(res.statusCode).toBe(200)
    const members = res.json().members as { sub: string; displayName: string }[]
    const subs = members.map((m) => m.sub)
    expect(subs).toContain('cmt-author')
    expect(subs).toContain('cmt-viewer')
    expect(subs).not.toContain('cmt-outsider') // a member, but cannot view the page
    expect(Object.keys(members[0]!).sort()).toEqual(['displayName', 'sub']) // no email/role leaked
  })

  it('a non-commenter cannot read the mention directory', async () => {
    expect((await get('viewer', `/pages/${PAGE}/mentionable`)).statusCode).toBe(403)
  })

  it('notifies a mentioned page-viewer by email (best-effort, real SMTP via Mailpit)', async () => {
    await clearMail()
    const r = await post('author', `/pages/${PAGE}/comments`, { body: 'hey @viewer', mentions: ['cmt-viewer'] })
    expect(r.statusCode).toBe(201)
    expect(await mailedTo('viewer@x.test')).toBe(true)
  })

  it('does NOT notify a mentioned member who cannot view the page (no page-existence leak)', async () => {
    await clearMail()
    const r = await post('author', `/pages/${PAGE}/comments`, { body: 'hey @outsider', mentions: ['cmt-outsider'] })
    expect(r.statusCode).toBe(201) // the comment is still created
    expect(await mailedTo('outsider@x.test')).toBe(false) // but no notification leaks the page
  })
})
