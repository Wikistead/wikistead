import type { Sql } from 'postgres'
import type { StorageDriver } from '../storage/index.js'
import { ManifestMismatchError } from './execute-database.js'

// ADR-252 §1 / #810: the STORAGE step of a tenant:reset sweep (the fourth of the five stores). Reads
// `tenant_sweep_manifests.storage_keys` — collected before the database step ran (manifest-keys.ts),
// which is the entire reason the manifest exists for this store: "attachments cascades from pages, so
// the moment the sweep deletes pages the only list of that tenant's S3 keys is gone" (ADR-252, "Both
// operations").
//
// Not run inside the database sweep's transaction — S3 is a separate store. `deleteObject` is a no-op
// on a key that does not exist (the interface's own contract, storage/driver.ts), so this step is
// idempotent the same way the FGA and search steps are.
export async function executeStorageSweep(sql: Sql, driver: StorageDriver, manifestId: string, tenantId: string): Promise<void> {
  const [manifest] = await sql<{ tenant_id: string; operation: string; storage_keys: string[] }[]>`
    SELECT tenant_id, operation, storage_keys FROM tenant_sweep_manifests WHERE id = ${manifestId}`
  if (!manifest) throw new ManifestMismatchError(`no manifest ${manifestId}`)
  if (manifest.tenant_id !== tenantId) throw new ManifestMismatchError(`manifest ${manifestId} belongs to tenant ${manifest.tenant_id}, not ${tenantId}`)
  if (manifest.operation !== 'reset') throw new ManifestMismatchError(`manifest ${manifestId} is a '${manifest.operation}' manifest, not 'reset'`)

  for (const key of manifest.storage_keys) {
    await driver.deleteObject(key)
  }

  const updated = await sql`UPDATE tenant_sweep_progress SET storage_done = true, updated_at = now() WHERE manifest_id = ${manifestId}`
  if (updated.count !== 1) throw new ManifestMismatchError(`expected exactly one progress row for manifest ${manifestId}, updated ${updated.count}`)
}
