// ADR-252 §1 / #810: executeSearchSweep — the Meilisearch step. Integration (real Postgres + real
// Meilisearch). Verifies: every page id the manifest names is removed from the index, a page NOT in
// the manifest (simulating a kept space's own, still-live page) is untouched, and the step is
// idempotent.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { LogicalSearchDriver } from '../search/index.js'
import { executeSearchSweep } from '../tenant-sweep/execute-search.js'
import { ManifestMismatchError } from '../tenant-sweep/execute-database.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_t810se'

async function seedManifest(searchDocumentIds: string[]): Promise<string> {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810se', 'business')
    ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_sweep_manifests (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
    VALUES (${TENANT}, 'reset', ${[]}, ${[]}, ${searchDocumentIds}) RETURNING id`
  await admin`INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${row.id})`
  return row.id
}

async function existsInIndex(pageId: string, title: string): Promise<boolean> {
  const hits = await driver.search({ tenantId: TENANT, userId: 'dev-user', groups: [], q: title, omitViewerFilter: true })
  return hits.some((h) => h.id === pageId)
}

afterAll(async () => {
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await driver.deleteDoc('page_t810se_doomed').catch(() => {})
  await driver.deleteDoc('page_t810se_kept').catch(() => {})
  await admin.end()
})

describe('executeSearchSweep (ADR-252 §1, #810)', () => {
  it('removes every manifested page from the index, leaves an unmentioned (kept-space) page untouched', async () => {
    await driver.upsertDoc({
      id: 'page_t810se_doomed', tenantId: TENANT, spaceId: 'space_t810se_doomed', title: 't810se-doomed-title',
      body: '', viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
    })
    await driver.upsertDoc({
      id: 'page_t810se_kept', tenantId: TENANT, spaceId: 'space_t810se_kept', title: 't810se-kept-title',
      body: '', viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
    })
    expect(await existsInIndex('page_t810se_doomed', 't810se-doomed-title'), 'sanity: the doomed doc is indexed before the sweep').toBe(true)
    expect(await existsInIndex('page_t810se_kept', 't810se-kept-title'), 'sanity: the kept doc is indexed before the sweep').toBe(true)

    const manifestId = await seedManifest(['page_t810se_doomed'])
    await executeSearchSweep(admin, driver, manifestId, TENANT)

    expect(await existsInIndex('page_t810se_doomed', 't810se-doomed-title'), 'the manifested page is gone from the index').toBe(false)
    expect(await existsInIndex('page_t810se_kept', 't810se-kept-title'), "an unmentioned (kept-space) page's document survives").toBe(true)

    const [progress] = await admin<{ search_done: boolean }[]>`SELECT search_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress.search_done).toBe(true)

    // idempotent: re-running is not an error
    await executeSearchSweep(admin, driver, manifestId, TENANT)
  })

  it('refuses a manifest for a different tenant, and an unknown manifest id', async () => {
    const manifestId = await seedManifest([])
    await expect(executeSearchSweep(admin, driver, manifestId, 'tenant_some_other_tenant')).rejects.toThrow(ManifestMismatchError)
    await expect(executeSearchSweep(admin, driver, 'not-a-real-manifest-id', TENANT)).rejects.toThrow(ManifestMismatchError)
  })
})
