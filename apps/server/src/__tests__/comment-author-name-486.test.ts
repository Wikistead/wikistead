// #486 / ADR-150 Addendum 2 (slice 2): the comments list resolves author display names server-side on
// this VIEW-GATED (guest:'view' — the one guest-facing) surface. Real Postgres + FGA + Fastify inject.
// Anti-tests: a member author resolves (override ?? OIDC); a CROSS-TENANT author → null (RLS absent, no
// leak); a GUEST author sub is dropped (→ null); no email / cross-tenant name anywhere in the payload.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme'
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const MEMBER = 'cmt486-member'
const FOREIGN = 'cmt486-foreign'

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'cmt486-space' })
  spaceId = space.id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'cmt486' })
  pageId = p.id
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, display_name_override, avatar_image_key) VALUES
    (${TENANT}, ${MEMBER}, ${MEMBER + '@e2e.test'}, 'member', 'IdP C', 'Member 486c', 'avatars/c.png'),
    (${OTHER}, ${FOREIGN}, ${FOREIGN + '@e2e.test'}, 'member', 'Foreign IdP', 'Foreign 486c', NULL)
    ON CONFLICT DO NOTHING`
  const [thread] = await admin`INSERT INTO comment_threads (tenant_id, page_id, kind, created_by) VALUES (${TENANT}, ${pageId}, 'page', ${MEMBER}) RETURNING id`
  await admin`INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES
    (${TENANT}, ${thread.id}, 'by member', ${MEMBER}),
    (${TENANT}, ${thread.id}, 'by foreign', ${FOREIGN}),
    (${TENANT}, ${thread.id}, 'by guest', 'guest:abc-123')`
}, 40_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {}) // cascades threads + comments
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM members WHERE sub LIKE 'cmt486-%'`.catch(() => {})
  await app.close()
  await db.release()
  await pool.end().catch(() => {})
  await admin.end().catch(() => {})
}, 40_000)

describe('GET /pages/:id/comments author identity (#486 slice 2)', () => {
  it('resolves member author names on the view-gated comments; cross-tenant & guest are null', async () => {
    const r = await app.inject({ method: 'GET', url: `/pages/${pageId}/comments`, headers: dev })
    expect(r.statusCode).toBe(200)
    const body = r.json() as { threads: { comments: { body: string; authorName: string | null; authorHasAvatar: boolean }[] }[] }
    const comments = body.threads.flatMap((t) => t.comments)
    const byBody = (b: string) => comments.find((c) => c.body === b)!
    expect(byBody('by member').authorName).toBe('Member 486c') // override ?? OIDC, resolved
    expect(byBody('by member').authorHasAvatar).toBe(true)
    // cross-tenant author → null (RLS absent), guest author sub → dropped → null
    expect(byBody('by foreign').authorName).toBeNull()
    expect(byBody('by guest').authorName).toBeNull()
    // no email / cross-tenant name leaks anywhere in the payload
    expect(r.body).not.toContain('@e2e.test')
    expect(r.body).not.toContain('Foreign')
  })
})
