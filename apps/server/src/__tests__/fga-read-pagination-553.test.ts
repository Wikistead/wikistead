// #553 re-review, the last of the un-paginated object reads. OpenFGA's Read answers ONE page
// (default 50) and truncates SILENTLY unless continuation_token is followed, so every decision made
// from a bare `fga.read({object})` is a decision made on an arbitrary subset. The two that could
// answer WRONG rather than merely incomplete get pins here:
//   - pageEventDisposition: the `private` marker falling past page one turns 'suppress' into
//     'deliver' — a private page's webhook shipping to a third party (fail-OPEN, the only one);
//   - isSpacePublic: `viewer@user:*` falling past page one reports a PUBLIC space as private.
// Both fixtures push the deciding tuple behind >50 siblings, so a bare read cannot see it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, isSpacePublic } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { pageEventDisposition } from '../page-disposition.js'
import { buildApp } from '../app.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let noise: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `pg-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pg-${STAMP}` })).id
  // 60 siblings on each object: more than one Read page, so the deciding tuple below cannot be on it
  noise = [
    ...Array.from({ length: 60 }, (_, i) => ({ user: `user:pg-noise-${i}-${STAMP}`, relation: 'viewer', object: `space:${spaceId}` })),
    ...Array.from({ length: 60 }, (_, i) => ({ user: `user:pg-noise-${i}-${STAMP}`, relation: 'view_direct', object: `page:${pageId}` })),
  ]
  await writeTuples(fgaClient, noise.slice(0, 60))
  await writeTuples(fgaClient, noise.slice(60))
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, noise).catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#553 re-review: object reads that decide must page to completion', () => {
  it('a private marker behind 60 siblings still SUPPRESSES the webhook (the fail-open one)', async () => {
    const priv = [
      { user: 'user:*', relation: 'private', object: `page:${pageId}` },
      { user: 'share_link:*', relation: 'private', object: `page:${pageId}` },
    ]
    await writeTuples(fgaClient, priv)
    try {
      expect(await pageEventDisposition(fgaClient, { pageId }), 'a truncated read would answer deliver').toBe('suppress')
    } finally {
      await deleteTuples(fgaClient, priv).catch(() => {})
    }
  }, 120_000)

  it('a public wildcard behind 60 siblings still reads as PUBLIC', async () => {
    const pub = [{ user: 'user:*', relation: 'viewer', object: `space:${spaceId}` }]
    await writeTuples(fgaClient, pub)
    try {
      expect(await isSpacePublic(fgaClient, { spaceId, userId: OWNER })).toBe(true)
    } finally {
      await deleteTuples(fgaClient, pub).catch(() => {})
    }
  }, 120_000)
})
