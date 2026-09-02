// ADR-252 §1 / #810: executeStorageSweep — the S3 step. Integration (real Postgres + real object
// storage via LogicalStorageDriver). Verifies: every key the manifest names is deleted, a key NOT in
// the manifest (simulating a kept space's own, still-live attachment) is untouched, and the step is
// idempotent.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { LogicalStorageDriver } from '../storage/index.js'
import { executeStorageSweep } from '../tenant-sweep/execute-storage.js'
import { ManifestMismatchError } from '../tenant-sweep/execute-database.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_t810st'
const doomedKey = 't810st/doomed-key'
const keptKey = 't810st/kept-key'

async function seedManifest(storageKeys: string[]): Promise<string> {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810st', 'business')
    ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_sweep_manifests (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
    VALUES (${TENANT}, 'reset', ${[]}, ${storageKeys}, ${[]}) RETURNING id`
  await admin`INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${row.id})`
  return row.id
}

async function exists(key: string): Promise<boolean> {
  try {
    await storage.headObject(key)
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await storage.deleteObject(doomedKey).catch(() => {})
  await storage.deleteObject(keptKey).catch(() => {})
  await admin.end()
})

describe('executeStorageSweep (ADR-252 §1, #810)', () => {
  it('deletes every manifested key, leaves an unmentioned (kept-space) key untouched', async () => {
    await storage.putObject(doomedKey, new TextEncoder().encode('doomed bytes'), 'text/plain')
    await storage.putObject(keptKey, new TextEncoder().encode('kept bytes'), 'text/plain')
    expect(await exists(doomedKey), 'sanity: the doomed object exists before the sweep').toBe(true)
    expect(await exists(keptKey), 'sanity: the kept object exists before the sweep').toBe(true)

    const manifestId = await seedManifest([doomedKey])
    await executeStorageSweep(admin, storage, manifestId, TENANT)

    expect(await exists(doomedKey), 'the manifested key is deleted').toBe(false)
    expect(await exists(keptKey), "an unmentioned (kept-space) key survives").toBe(true)

    const [progress] = await admin<{ storage_done: boolean }[]>`SELECT storage_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress.storage_done).toBe(true)

    // idempotent: re-running (the key is already gone) is not an error — the interface's own
    // contract (storage/driver.ts: "no-op if the object does not exist")
    await executeStorageSweep(admin, storage, manifestId, TENANT)
  })

  it('refuses a manifest for a different tenant, and an unknown manifest id', async () => {
    const manifestId = await seedManifest([])
    await expect(executeStorageSweep(admin, storage, manifestId, 'tenant_some_other_tenant')).rejects.toThrow(ManifestMismatchError)
    await expect(executeStorageSweep(admin, storage, 'not-a-real-manifest-id', TENANT)).rejects.toThrow(ManifestMismatchError)
  })
})
