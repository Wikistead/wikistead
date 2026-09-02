import type { Sql } from 'postgres'
import type { SearchDriver } from '@wikistead/hooks'
import { ManifestMismatchError } from './execute-database.js'

// ADR-252 §1 / #810: the SEARCH step of a tenant:reset sweep (the third of the five stores). Reads
// `tenant_sweep_manifests.search_document_ids` — which `writeResetManifest` set to `doomed.pageIds`
// unchanged (search/driver.ts's `deleteDoc` takes the page id directly as Meilisearch's own primary
// key, so no separate collection or transformation was ever needed for this store).
//
// Not run inside the database sweep's transaction — Meilisearch is a separate store with no shared
// transaction boundary. `deleteDoc` on an id already absent from the index is a no-op (Meilisearch's
// delete-by-id does not error on a missing document), so this step is idempotent the same way the FGA
// step is: re-running it after an interruption needs no partial-progress bookkeeping of its own.
export async function executeSearchSweep(sql: Sql, driver: SearchDriver, manifestId: string, tenantId: string): Promise<void> {
  const [manifest] = await sql<{ tenant_id: string; operation: string; search_document_ids: string[] }[]>`
    SELECT tenant_id, operation, search_document_ids FROM tenant_sweep_manifests WHERE id = ${manifestId}`
  if (!manifest) throw new ManifestMismatchError(`no manifest ${manifestId}`)
  if (manifest.tenant_id !== tenantId) throw new ManifestMismatchError(`manifest ${manifestId} belongs to tenant ${manifest.tenant_id}, not ${tenantId}`)
  if (manifest.operation !== 'reset') throw new ManifestMismatchError(`manifest ${manifestId} is a '${manifest.operation}' manifest, not 'reset'`)

  for (const pageId of manifest.search_document_ids) {
    await driver.deleteDoc(pageId)
  }

  const updated = await sql`UPDATE tenant_sweep_progress SET search_done = true, updated_at = now() WHERE manifest_id = ${manifestId}`
  if (updated.count !== 1) throw new ManifestMismatchError(`expected exactly one progress row for manifest ${manifestId}, updated ${updated.count}`)
}
