import { computeDoomedIds } from './doomed-ids.js'
import { collectResetStorageKeys, type DoomedIds } from './manifest-keys.js'
import { collectResetFgaObjectIds } from './manifest-fga.js'
import type { Queryable } from './derive.js'

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
// ⚠️ review c-af763a4 (5th pass, G6): "at most one unfinished reset per tenant" (the
// invariant `tenant-reset.ts`'s per-tenant `pg_advisory_xact_lock` protects) is enforced by the CLI's
// `resetTenant`, not by this function — the actual choke point every write to this table passes
// through. This is exported and called directly by several tests in this ticket without going through
// `resetTenant`, and ADR-252 names a SECOND caller not yet built (the workspace settings screen's own
// HTTP route, §1's PRIMARY surface) — if that route ever calls this function without ALSO taking
// `tenantResetLockKey(tenantId)` first, F1's race (two unfinished manifests for one tenant) reopens
// silently, with no signal here that anything went wrong. Any future caller of this function directly
// (rather than through `resetTenant`) must hold that lock itself.
export interface ResetManifestResult {
  manifestId: string
  doomed: DoomedIds
}

export async function writeResetManifest(sql: Queryable, tenantId: string, keepSpaceIds: readonly string[]): Promise<ResetManifestResult> {
  const doomed = await computeDoomedIds(sql, tenantId, keepSpaceIds)
  const storageKeys = await collectResetStorageKeys(sql, tenantId, doomed)
  const fgaObjectIds = collectResetFgaObjectIds(doomed)
  const searchDocumentIds = doomed.pageIds

  // review c-af763a4 (4th pass, F3): the manifest row and its progress row used to be two
  // separate INSERTs — a crash between them left a manifest with no progress row, which the unfinished-
  // sweep check in tenant-reset.ts (an INNER JOIN at the time) could not see at all, silently defeating
  // the very refusal that same review round's D1 finding added. A single statement is atomic by
  // construction (Postgres never partially applies one), so there is no window between "manifest
  // exists" and "progress exists" for anything to observe — not a transaction wrapped around two
  // statements (which would need `Queryable` to support nested transactions, an open question this
  // avoids entirely by not needing one).
  const [row] = await sql<{ manifest_id: string }[]>`
    WITH manifest AS (
      INSERT INTO tenant_sweep_manifests
        (tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids)
      VALUES (${tenantId}, 'reset', ${[...keepSpaceIds]}, ${fgaObjectIds}, ${storageKeys}, ${[...searchDocumentIds]})
      RETURNING id
    )
    INSERT INTO tenant_sweep_progress (manifest_id)
    SELECT id FROM manifest
    RETURNING manifest_id`

  return { manifestId: row.manifest_id, doomed }
}
