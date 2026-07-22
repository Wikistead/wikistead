// #486 / ADR-150 Addendum 2 (slice 4): the activity feed resolves the actor display name server-side, on
// the VIEW-FILTERED set (R3 — after gateEvents' double gate, never the raw rows). Real Postgres + FGA.
// Anti-tests: a member actor resolves (override ?? OIDC, user:<sub> prefix stripped); a CROSS-TENANT actor
// → null (RLS absent — the name never crosses the tenant even though the event is viewable); a GUEST/anon
// actor → null (the UI keeps its "Guest" label); no email / cross-tenant name in the payload.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { listFeed } from '../routes/notifications.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme'
const MEMBER = 'feed486-member'
const FOREIGN = 'feed486-foreign'

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'feed486-space' })
  spaceId = space.id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'feed486' })
  pageId = p.id
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, display_name_override) VALUES
    (${TENANT}, ${MEMBER}, ${MEMBER + '@e2e.test'}, 'member', 'IdP F', 'Member 486f'),
    (${OTHER}, ${FOREIGN}, ${FOREIGN + '@e2e.test'}, 'member', 'Foreign IdP', 'Foreign 486f')
    ON CONFLICT DO NOTHING`
  // feed_events store the actor as the FGA-principal form `user:<sub>` (or guest:/anon:). The events are
  // on a page dev-user can view → they pass gateEvents; the actor's name is what we resolve.
  await admin`INSERT INTO feed_events (tenant_id, event_type, page_id, space_id, actor) VALUES
    (${TENANT}, 'page.published', ${pageId}, ${spaceId}, ${'user:' + MEMBER}),
    (${TENANT}, 'page.published', ${pageId}, ${spaceId}, ${'user:' + FOREIGN}),
    (${TENANT}, 'page.published', ${pageId}, ${spaceId}, 'guest:abc-123')`
}, 40_000)

afterAll(async () => {
  await admin`DELETE FROM feed_events WHERE page_id = ${pageId}`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM members WHERE sub LIKE 'feed486-%'`.catch(() => {})
  await db.release()
  await pool.end().catch(() => {})
  await admin.end().catch(() => {})
}, 40_000)

describe('listFeed actor identity (#486 slice 4)', () => {
  it('resolves member actor names (stripping user:); cross-tenant & guest are null', async () => {
    const feed = await listFeed(db, fgaClient, { subject: 'user:dev-user', spaceId })
    const byActor = (a: string) => feed.find((f) => f.actor === a)!
    expect(byActor('user:' + MEMBER).actorName).toBe('Member 486f')
    expect(byActor('user:' + FOREIGN).actorName).toBeNull() // cross-tenant → RLS absent
    expect(byActor('guest:abc-123').actorName).toBeNull()   // guest actor dropped
    const json = JSON.stringify(feed)
    expect(json).not.toContain('@e2e.test')
    expect(json).not.toContain('Foreign')
  })
})
