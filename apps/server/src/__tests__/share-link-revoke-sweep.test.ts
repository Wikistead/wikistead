// Integration tests — real Postgres + real OpenFGA. The ONLY mock is an injected faulty FGA client used to
// force revokeResourceShareLinks down its FGA-delete-failure branch (a real FGA rarely errors on delete).
// Security-critical (#220): auto-recovery of a "page private but its share link is still live on FGA" leak
// window, WITHOUT ever revoking a legitimate active link (option A — durable marker, not re-derivation).
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, checkRelation, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, setPagePrivate } from '../routes/pages.js'
import { createShareLink, revokeResourceShareLinks, sweepShareLinkRevokeFailures } from '../routes/share-links.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()

// A stand-in FGA client whose write ALWAYS errors with a non-"did not exist" message — this is how we force
// revokeResourceShareLinks down its failure branch. The DB reads inside revoke use the real `db`, and the
// link's real FGA tuple is untouched (the faulty client is a different object), so it stays live afterwards.
const faultyFga = { write: async () => { throw new Error('fga unavailable (injected)') } } as unknown as OpenFgaClient

let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'revoke-sweep-space' })
  spaceId = space.id
})
afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
})

async function markerState(id: string) {
  const [row] = await db.sql<{ revoked_at: Date | null; revoke_failed_at: Date | null }[]>`
    SELECT revoked_at, revoke_failed_at FROM share_links WHERE id = ${id}`
  return row
}
const linkLive = (linkId: string, pageId: string) =>
  checkRelation(fgaClient, `share_link:${linkId}`, 'view', { type: 'page', id: pageId })

describe('#220 share-link revoke-failure durable marker + sweep', () => {
  it('records revoke_failed_at when the FGA delete fails, leaving the link live and recoverable', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'p-fail' })
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', resource: { type: 'page', id: page.id }, capability: 'view', expiresInSeconds: null })
    expect(await linkLive(link.id, page.id)).toBe(true)

    // Revoke with a faulty FGA → the delete errors, so the link is recorded as a durable failure.
    const { revoked, failed } = await revokeResourceShareLinks(db, faultyFga, { type: 'page', id: page.id }, tenant.id, 'dev-user')
    expect(revoked).toEqual([])
    expect(failed).toEqual([link.id])

    const st = await markerState(link.id)
    expect(st.revoke_failed_at).not.toBeNull() // durable marker set (#220)
    expect(st.revoked_at).toBeNull()           // NOT yet revoked — fail-safe & recoverable
    expect(await linkLive(link.id, page.id)).toBe(true) // the "private but link alive on FGA" leak window

    // The sweep (real FGA back up) retries the delete and completes the revoke.
    const healed = await sweepShareLinkRevokeFailures(fgaClient)
    expect(healed).toBeGreaterThanOrEqual(1)
    const after = await markerState(link.id)
    expect(after.revoked_at).not.toBeNull()   // revoke completed
    expect(after.revoke_failed_at).toBeNull() // marker cleared
    expect(await linkLive(link.id, page.id)).toBe(false) // FGA tuple gone
  })

  it('the sweep NEVER revokes a legitimate active link on a private page (marker NULL)', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'p-legit' })
    await setPagePrivate(db, fgaClient, driver, { tenantId: tenant.id, pageId: page.id, userId: 'dev-user', plan: tenant.plan })
    // A link the manager keeps live on a private page: active, marker NULL. Option B (re-derive "private +
    // revoked_at NULL") would wrongly revoke this; option A (marker) must leave it untouched.
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', resource: { type: 'page', id: page.id }, capability: 'view', expiresInSeconds: null })
    expect((await markerState(link.id)).revoke_failed_at).toBeNull()

    await sweepShareLinkRevokeFailures(fgaClient)

    const st = await markerState(link.id)
    expect(st.revoked_at).toBeNull()        // untouched — sweep only processes marked links
    expect(st.revoke_failed_at).toBeNull()
    expect(await linkLive(link.id, page.id)).toBe(true) // still live
  })

  it('is idempotent: a "did not exist" FGA delete (tuple already gone) still completes the revoke', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'p-idem' })
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', resource: { type: 'page', id: page.id }, capability: 'view', expiresInSeconds: null })
    // Simulate a partial prior failure: marker recorded, but the FGA tuple is already gone.
    await db.sql`UPDATE share_links SET revoke_failed_at = now() WHERE id = ${link.id}`
    await deleteTuples(fgaClient, [{ user: `share_link:${link.id}`, relation: 'view_base', object: `page:${page.id}` }])

    const healed = await sweepShareLinkRevokeFailures(fgaClient)
    expect(healed).toBeGreaterThanOrEqual(1)
    const st = await markerState(link.id)
    expect(st.revoked_at).not.toBeNull()   // "did not exist" counted as cleared → revoke completed
    expect(st.revoke_failed_at).toBeNull()

    // A re-run is a no-op for this link (revoked_at set → filtered out of the sweep).
    await sweepShareLinkRevokeFailures(fgaClient)
    expect((await markerState(link.id)).revoked_at).not.toBeNull()
  })
})
