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
// not to make a single step repeated safer, which it already is.
//
// ⚠️ review c-af763a4 (5th pass, G4): "idempotent, so resumable" was measured for SEQUENTIAL
// re-runs (one call finishes or crashes, then a LATER call resumes) — tenant-reset.ts's per-tenant lock
// (`resetTenant`) guarantees at most one caller ever WRITES a manifest or newly resumes one at a time,
// but the lock is released before this function runs, so two callers that both resumed the SAME
// manifest (e.g. one held the lock and resumed, a second arrived after that resume committed and — with
// a matching --keep — also resumed the same still-unfinished manifest) can call this function
// CONCURRENTLY on it. Each individual step's idempotency still holds (no double-delete corruption), but
// `packages/authz/src/tuples.ts`'s `deleteObjectTuples` (used by `executeFgaSweep`) is a read-then-
// delete whose own #619 comment says a racing delete on the SAME object can make the loser's call fail
// outright — so a concurrent resume of the same manifest is safe from data corruption but may SURFACE a
// transient FGA error to whichever caller loses that particular race, not a smooth no-op.
//
// ⚠️ database MUST run first — review c-af763a4 found the original version of this comment
// overclaimed "the order between the four steps never matters" from the fact that fga/search/storage
// each read their OWN targets from the manifest (a fixed, pre-computed list — never affected by what
// order they run in relative to each other). That is true for THOSE three, but not for database-first
// relative to the other three: manifest-keys.ts's storage-key collection and manifest-fga.ts's object
// collection both read LIVE rows (attachments.s3_key, the FGA object ids implied by which pages/spaces
// still exist) — but they run once, at manifest-write time, BEFORE any of these four steps. If the
// database step ran AFTER fga/search/storage instead of before, a crash between them would not corrupt
// data (each step is still independently correct against the manifest it already has), but a crash
// mid-way would still leave whatever fga/search/storage already cleared without the database rows that
// justified clearing them removed yet — recoverable, not silent data loss, but the wrong order to
// prefer. `database_done` first, in `tenant_sweep_progress`'s own column order, is deliberate: it is
// the store every other step's manifest was built by reading, so it goes first when nothing is
// resuming and nothing here reorders it.
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
