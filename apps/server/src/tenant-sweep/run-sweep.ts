import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import type { SearchDriver } from '@wikistead/hooks'
import type { StorageDriver } from '../storage/index.js'
import { executeDatabaseSweep, ManifestMismatchError } from './execute-database.js'
import { executeFgaSweep } from './execute-fga.js'
import { executeSearchSweep } from './execute-search.js'
import { executeStorageSweep } from './execute-storage.js'
import type { DoomedIds } from './manifest-keys.js'

// ADR-252 §1 / #810: runs whichever of the four built store-steps a manifest has not yet completed,
// in `tenant_sweep_progress`'s own column order (database, fga, search, storage — sessions_done is
// the reserved fifth column, migration 135, still unset by anything: §6b proposes the sessions store
// but does not implement it, so no executor for it exists to call here).
//
// Resumable BY CONSTRUCTION, not by anything this function adds: each step is independently
// idempotent (re-running database's row deletes matches zero rows for anything already gone; FGA/
// search/storage's deletes are no-ops on an already-cleared object) and each already checks the
// manifest/tenant/operation consistency itself. This function's only job is to SKIP a step
// `tenant_sweep_progress` already marks done, so re-running after a crash does not redo real work —
// not to make a single step safer to repeat, which it already is.
//
// ⚠️ Deliberately never deletes the manifest, unlike ADR-252's "the manifest is deleted when every
// store has been verified" — because a fifth store (sessions) is proposed but not built (§6b), so
// "every store" is never actually true yet. Calling this function to completion leaves the manifest
// present, correctly signalling (per the ADR's own words: "its presence means the sweep is
// unfinished") that the reset is not done. Whoever builds sessions is also the one who gets to close
// this loop; stubbing a fifth call here that does nothing would be the "declaration that cannot act"
// shape this codebase's own conventions warn against.
export interface RunSweepDeps {
  fga: OpenFgaClient
  search: SearchDriver
  storage: StorageDriver
}

export async function runResetSweep(sql: Sql, deps: RunSweepDeps, manifestId: string, tenantId: string, doomed: DoomedIds): Promise<void> {
  const [progress] = await sql<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
    SELECT database_done, fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
  if (!progress) throw new ManifestMismatchError(`no progress row for manifest ${manifestId}`)

  if (!progress.database_done) await executeDatabaseSweep(sql, manifestId, tenantId, doomed)
  if (!progress.fga_done) await executeFgaSweep(sql, deps.fga, manifestId, tenantId)
  if (!progress.search_done) await executeSearchSweep(sql, deps.search, manifestId, tenantId)
  if (!progress.storage_done) await executeStorageSweep(sql, deps.storage, manifestId, tenantId)
}
