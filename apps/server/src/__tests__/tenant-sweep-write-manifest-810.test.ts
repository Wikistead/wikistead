// ADR-252 §1 / #810: writeResetManifest — the single entry point that ties computeDoomedIds,
// collectResetStorageKeys and collectResetFgaObjectIds into the one durable write §1 requires before
// anything destructive runs. Integration (real Postgres): a tenant with a kept space and a doomed
// space, each with a page and an attachment.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810wm'

afterAll(async () => {
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN
    (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  for (const tbl of ['attachments', 'pages', 'spaces']) await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end()
})

describe('writeResetManifest (ADR-252 §1, #810)', () => {
  it('writes one manifest row and one unstarted progress row, with all four collectors\' output', async () => {
    await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810wm', 'business')
      ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
    const kept = 'space_t810wm_kept'
    const doomed = 'space_t810wm_doomed'
    for (const s of [kept, doomed]) {
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s}, ${TENANT}, ${s}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${s + '_page'}, ${TENANT}, ${s}, ${s}, ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, size_bytes, s3_key, status)
        VALUES (${s + '_att'}, ${TENANT}, ${s + '_page'}, 'f.png', 'image/png', 10, ${s + '/att-key'}, 'confirmed')
        ON CONFLICT (id) DO NOTHING`
    }

    const { manifestId, doomed: doomedIds } = await writeResetManifest(admin, TENANT, [kept])

    // the returned DoomedIds are usable by the caller without a re-query
    expect(doomedIds.spaceIds).toEqual([doomed])
    expect([...doomedIds.pageIds].sort()).toEqual([doomed + '_page', kept + '_page'].sort())

    const [manifest] = await admin<{
      tenant_id: string
      operation: string
      keep_space_ids: string[]
      fga_object_ids: string[]
      storage_keys: string[]
      search_document_ids: string[]
    }[]>`SELECT tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids
         FROM tenant_sweep_manifests WHERE id = ${manifestId}`
    expect(manifest.tenant_id).toBe(TENANT)
    expect(manifest.operation).toBe('reset')
    expect(manifest.keep_space_ids).toEqual([kept])
    // FGA: doomed space's object + BOTH pages (kept space's page is swept too)
    expect(manifest.fga_object_ids.sort()).toEqual([`space:${doomed}`, `page:${doomed}_page`, `page:${kept}_page`].sort())
    // storage: BOTH pages' attachments (kept space's page is swept too), never the kept space's
    // SPACE-level keys (none exist in this fixture, but the doomed-space-only scoping is what
    // manifest-keys.ts's own break-check already proved)
    expect(manifest.storage_keys.sort()).toEqual([`${doomed}/att-key`, `${kept}/att-key`].sort())
    // search: exactly doomed.pageIds, unchanged
    expect(manifest.search_document_ids.sort()).toEqual([...doomedIds.pageIds].sort())

    const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean; sessions_done: boolean }[]>`
      SELECT database_done, fga_done, search_done, storage_done, sessions_done
      FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress).toEqual({ database_done: false, fga_done: false, search_done: false, storage_done: false, sessions_done: false })
  })
})
