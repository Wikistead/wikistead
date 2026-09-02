import type { Sql } from 'postgres'
import { computeDoomedIds } from './doomed-ids.js'
import { collectResetStorageKeys, type DoomedIds } from './manifest-keys.js'
import { collectResetFgaObjectIds } from './manifest-fga.js'

// ADR-252 §1 / #810: "A durable manifest is written before anything is destroyed" — ties the
// collectors this directory already has (computeDoomedIds, collectResetStorageKeys,
// collectResetFgaObjectIds) into the one INSERT the executor (not yet built) reads from, so nothing
// destructive ever runs without a written record of what it is about to touch already committed.
//
// search_document_ids needs no collector of its own: search/driver.ts's `deleteDoc` takes the page id
// directly as Meilisearch's primary key, so it is `doomed.pageIds` unchanged (recorded in the
// doomed-ids.ts commit that found this — not repeated as a function here, a wrapper with no
// transformation would be the exact premature abstraction that commit already declined to add).
//
// Writes ONLY the manifest and its progress row — no space, page or any other tenant row is read
// beyond what `computeDoomedIds` already selects to build the id sets. This function's own write is
// to `tenant_sweep_manifests` / `tenant_sweep_progress` alone, both excluded from every derivation in
// `derive.ts` by name, so re-running the discovery in this same directory never finds its own output.
export interface ResetManifestResult {
  manifestId: string
  doomed: DoomedIds
}

export async function writeResetManifest(sql: Sql, tenantId: string, keepSpaceIds: readonly string[]): Promise<ResetManifestResult> {
  const doomed = await computeDoomedIds(sql, tenantId, keepSpaceIds)
  const storageKeys = await collectResetStorageKeys(sql, tenantId, doomed)
  const fgaObjectIds = collectResetFgaObjectIds(doomed)
  const searchDocumentIds = doomed.pageIds

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tenant_sweep_manifests
      (tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids)
    VALUES (${tenantId}, 'reset', ${[...keepSpaceIds]}, ${fgaObjectIds}, ${storageKeys}, ${[...searchDocumentIds]})
    RETURNING id`
  await sql`INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${row.id})`

  return { manifestId: row.id, doomed }
}
