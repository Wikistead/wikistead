import type { OpenFgaClient } from '@openfga/sdk'
import type { Sql } from 'postgres'
import { deleteObjectTuples } from '@wikistead/authz'
import { ManifestMismatchError } from './execute-database.js'

// ADR-252 §1 / #810: the OpenFGA step of a tenant:reset sweep (the second of the five stores). Reads
// `tenant_sweep_manifests.fga_object_ids` — written by `writeResetManifest` before the database step
// ever ran, so this step does not need the tenant's rows to still exist to know what to clear (the
// exact reason the manifest exists: "the manifest is an index of what a removed workspace called its
// files", migration 135).
//
// Not run inside the database sweep's transaction — OpenFGA is a separate store with no shared
// transaction boundary, which is why `tenant_sweep_progress` tracks each store's completion
// independently rather than assuming one commit covers all five. `deleteObjectTuples` is idempotent
// (reads an object's current tuples, then deletes exactly those — an object with none already cleared
// is a no-op), so re-running this whole step after an interruption is safe without any partial-progress
// bookkeeping of its own; the outer retry IS the resumability.
export async function executeFgaSweep(sql: Sql, fga: OpenFgaClient, manifestId: string, tenantId: string): Promise<void> {
  const [manifest] = await sql<{ tenant_id: string; operation: string; fga_object_ids: string[] }[]>`
    SELECT tenant_id, operation, fga_object_ids FROM tenant_sweep_manifests WHERE id = ${manifestId}`
  if (!manifest) throw new ManifestMismatchError(`no manifest ${manifestId}`)
  if (manifest.tenant_id !== tenantId) throw new ManifestMismatchError(`manifest ${manifestId} belongs to tenant ${manifest.tenant_id}, not ${tenantId}`)
  if (manifest.operation !== 'reset') throw new ManifestMismatchError(`manifest ${manifestId} is a '${manifest.operation}' manifest, not 'reset'`)

  for (const object of manifest.fga_object_ids) {
    await deleteObjectTuples(fga, object)
  }

  const updated = await sql`UPDATE tenant_sweep_progress SET fga_done = true, updated_at = now() WHERE manifest_id = ${manifestId}`
  if (updated.count !== 1) throw new ManifestMismatchError(`expected exactly one progress row for manifest ${manifestId}, updated ${updated.count}`)
}
