// Integration test — real Postgres + OpenFGA. Orphan-draft admin handoff, READ side
// (#99 / ADR-061). authz-critical: enumeration must list ACTUALLY-orphaned drafts only
// (creator gone + no live viewer), never a live creator's / live-shared strict-private
// draft, and the capability is hidden (404) from non-admins.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { listOrphanDrafts, requireTenantAdminOr404 } from '../routes/orphan-drafts.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))

let db: TenantDb
let spaceId: string
const pageIds: string[] = []

async function mkPage(title: string): Promise<string> {
  // dev-user is a space manager (created the space), so createPage is authorized; it writes
  // dev-user's `manage` tuple = the strict-private draft state (no page#space until publish).
  const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title })
  pageIds.push(p.id)
  return p.id
}

const ids = async () => (await listOrphanDrafts(db, fgaClient, { tenantId: TENANT })).map((o) => o.id)

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `orphan-sp-${Date.now().toString(36)}` })).id
}, 30_000)

afterAll(async () => {
  for (const id of pageIds) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('listOrphanDrafts (#99 / ADR-061 read side)', () => {
  it('lists a draft whose creator tuple is gone (zero live grants) as an orphan', async () => {
    const orphan = await mkPage('orphan-zero-grant')
    await deleteObjectTuples(fgaClient, `page:${orphan}`) // simulate creator deletion → all tuples gone
    expect(await ids()).toContain(orphan)
  })

  it('lists a draft whose only grant points at a NON-member (deleted creator) as an orphan', async () => {
    const orphan = await mkPage('orphan-stale-grant')
    await deleteObjectTuples(fgaClient, `page:${orphan}`)
    // A leftover grant for a user who is NOT a tenant member must not count as "reachable".
    await writeTuples(fgaClient, [{ user: 'user:ghost-deleted-creator', relation: 'manage', object: `page:${orphan}` }])
    expect(await ids()).toContain(orphan)
  })

  it('does NOT list a draft a live member can still reach (strict-private for live creators holds)', async () => {
    const live = await mkPage('live-creator') // keeps dev-user's manage tuple; dev-user is a member
    const result = await ids()
    expect(result).not.toContain(live)
    // and a live VIEWER (non-creator path): creator tuple gone but a live member holds view
    const shared = await mkPage('live-viewer')
    await deleteObjectTuples(fgaClient, `page:${shared}`)
    await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'view', object: `page:${shared}` }]) // dev-user is live
    expect(await ids()).not.toContain(shared)
  })

  it('does NOT list a PUBLISHED page (published_at set ⇒ not a draft candidate)', async () => {
    const pub = await mkPage('published-not-orphan')
    await admin`UPDATE pages SET ydoc = ${ydoc('# pub\n')} WHERE id = ${pub}`
    await publishPage(db, fgaClient, driver, { pageId: pub, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    // Even after stripping its grants, a published page is not a draft → never an orphan candidate.
    await deleteObjectTuples(fgaClient, `page:${pub}`)
    expect(await ids()).not.toContain(pub)
  })
})

describe('requireTenantAdminOr404 (existence-hiding gate)', () => {
  it('rejects a non-admin with 404 (not 403 — capability existence hidden)', async () => {
    await expect(requireTenantAdminOr404(fgaClient, 'orphan-stranger-nonadmin', TENANT))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('admits a tenant#admin (dev-user)', async () => {
    await expect(requireTenantAdminOr404(fgaClient, 'dev-user', TENANT)).resolves.toBeUndefined()
  })
})
