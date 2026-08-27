// ADR-253 §3.1/§3.3/§3.4/§3.4a/§3.6: which OpenFGA store this deployment binds to — found, not
// transcribed. This module answers ONLY "which store" (and whether it had to be created); §3.5's
// model reconcile is wired in separately, the same separation migration-guard.ts keeps between the
// pure verdict and the boot-time refusal.
import type { Sql } from 'postgres'
import { OpenFgaClient, FgaApiNotFoundError } from '@openfga/sdk'
import { decideStoreBinding, describeRefusal, type Witness, type Candidate } from '@wikistead/authz'

/** Every store name this product's tooling creates (`infra/openfga/bootstrap.ts` and its kin). */
export const STORE_NAME = 'wikistead'
// Any syntactically valid ULID works for calls made before a real store id is known — the same
// dummy `bootstrap.ts` and `infra/openfga/model-drift.ts` already use for listing.
export const DUMMY_STORE_ID = '01H5M3YCPQ3ZHWT1J8RYATM4WN'

export interface FgaStoreSummary {
  id: string
  name: string
}

/**
 * §3.3: drains the continuation token. `bootstrap.ts`, `reset-test-store.ts` and `model-drift.ts`
 * each read only the first page today — on a deployment whose store sits on page two, that reads as
 * "none", which §3.4 turns into a CREATE, and from the next boot onward §3.3 refuses forever because
 * now there really are two.
 */
export async function listAllStores(fga: OpenFgaClient): Promise<FgaStoreSummary[]> {
  const out: FgaStoreSummary[] = []
  let continuationToken: string | undefined
  do {
    const { stores, continuation_token } = await fga.listStores({ continuationToken, pageSize: 100 })
    for (const s of stores ?? []) out.push({ id: s.id, name: s.name })
    continuationToken = continuation_token || undefined
  } while (continuationToken)
  return out
}

export type NameSearch =
  | { kind: 'found'; storeId: string }
  | { kind: 'none' }
  // More than one store wears the name: never picked between silently (never "the newest"). The
  // caller refuses, naming every id found, so an operator can pin the right one (§3.1).
  | { kind: 'ambiguous'; ids: string[] }

/** Pure: §3.3's ambiguity rule, over an already-drained list. */
export function searchByName(stores: readonly FgaStoreSummary[], name: string): NameSearch {
  const ids = stores.filter((s) => s.name === name).map((s) => s.id)
  if (ids.length === 0) return { kind: 'none' }
  if (ids.length === 1) return { kind: 'found', storeId: ids[0]! }
  return { kind: 'ambiguous', ids }
}

/** Whether a specific store id still answers. A 404 is "gone"; anything else is a real failure. */
export async function storeExists(fga: OpenFgaClient, storeId: string): Promise<boolean> {
  try {
    await fga.getStore({ storeId })
    return true
  } catch (e) {
    if (e instanceof FgaApiNotFoundError) return false
    throw e
  }
}

// ADR-253 §3.4: the witness table. Bare `sql` — resolution runs before any tenant exists, on a
// connection that sets no app.tenant_id, and the table carries no RLS for exactly that reason.
export type WitnessRead = { kind: 'row'; witness: Witness } | { kind: 'no-table' }

/** `no-table` is §3.4a's case: this deployment has not been migrated this far yet. */
export async function readWitness(sql: Sql): Promise<WitnessRead> {
  try {
    const rows = await sql<{ store_id: string }[]>`SELECT store_id FROM openfga_store_binding WHERE id = 'singleton'`
    return { kind: 'row', witness: rows[0] ? { storeId: rows[0].store_id } : null }
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return { kind: 'no-table' }
    throw e
  }
}

/** Binds this deployment to `storeId` for the first time. INSERT, not UPSERT: rebinding is `rebindWitness`. */
export async function writeWitness(sql: Sql, storeId: string): Promise<void> {
  await sql`INSERT INTO openfga_store_binding (store_id) VALUES (${storeId})`
}

/** The rotate/reset test-stack path (ADR-253 §3.4, last table row): the binding moves, not the row. */
export async function rebindWitness(sql: Sql, storeId: string): Promise<void> {
  await sql`
    INSERT INTO openfga_store_binding (id, store_id) VALUES ('singleton', ${storeId})
    ON CONFLICT (id) DO UPDATE SET store_id = EXCLUDED.store_id, bound_at = now()
  `
}

/** ADR-253 §8②'s forget command: deletes the row only, never touches a store. */
export async function forgetWitness(sql: Sql): Promise<void> {
  await sql`DELETE FROM openfga_store_binding WHERE id = 'singleton'`
}

export type StoreBindingResult =
  | { kind: 'bound'; storeId: string; created: boolean }
  | { kind: 'refuse'; message: string }
  | { kind: 'wait-for-migration' }

/**
 * The orchestrator: §3.1's explicit id, else §3.3's name search, combined with §3.4's witness via
 * `decideStoreBinding`. Does NOT create a store itself when the decision says `create` — the caller
 * does that (it is the one holding the advisory lock, ADR-253 §3.6, and creation is a network call
 * this function's caller may want to place inside or outside that lock's own retry policy).
 */
export async function resolveStoreBinding(deps: {
  fga: OpenFgaClient
  sql: Sql
  explicitStoreId: string | undefined
}): Promise<
  | StoreBindingResult
  // 'create': the caller must call OpenFGA to create the store, then `writeWitness` with the new id.
  | { kind: 'create' }
> {
  const witnessRead = await readWitness(deps.sql)
  if (witnessRead.kind === 'no-table') return { kind: 'wait-for-migration' }
  const witness = witnessRead.witness

  let candidate: Candidate
  if (deps.explicitStoreId) {
    // §3.1: an explicit id always wins, with no listing and no creation.
    candidate = { storeId: deps.explicitStoreId }
  } else {
    const stores = await listAllStores(deps.fga)
    const search = searchByName(stores, STORE_NAME)
    if (search.kind === 'ambiguous') {
      return {
        kind: 'refuse',
        message:
          `more than one store is named "${STORE_NAME}": ${search.ids.join(', ')} — pin OPENFGA_STORE_ID ` +
          `explicitly to the right one (ADR-253 §3.3)`,
      }
    }
    candidate = search.kind === 'found' ? { storeId: search.storeId } : 'none'
  }

  const candidateIsLive = candidate === 'none' ? null : await storeExists(deps.fga, candidate.storeId)
  const witnessStoreIsLive =
    witness === null || (candidate !== 'none' && candidate.storeId === witness.storeId)
      ? null // same id as candidate (or no witness at all) — candidateIsLive already answers this
      : await storeExists(deps.fga, witness.storeId)

  const decision = decideStoreBinding({ witness, candidate, candidateIsLive, witnessStoreIsLive })
  switch (decision.kind) {
    case 'create':
      return { kind: 'create' }
    case 'adopt':
      await writeWitness(deps.sql, decision.storeId)
      return { kind: 'bound', storeId: decision.storeId, created: false }
    case 'proceed':
      return { kind: 'bound', storeId: decision.storeId, created: false }
    case 'refuse':
      return { kind: 'refuse', message: describeRefusal(decision.reason) }
  }
}

/**
 * ADR-253 §3.6: the server and the collaboration server boot independently and share one database.
 * Resolution runs inside a transaction holding a Postgres advisory lock — the one thing both already
 * share, since OpenFGA offers no primitive for this. A process that cannot take the lock waits for
 * the holder and then re-reads (postgres.js's `pg_advisory_xact_lock` blocks until acquired and
 * releases automatically at transaction end — including a crash, which a session-level lock would
 * not). `bootstrap.ts` (ADR-253 §3.6a) takes the same lock.
 *
 * This is the entry point callers use — it performs the CREATE decisions leaves to the caller
 * (`resolveStoreBinding` never calls the network on its own) and writes the witness for a newly
 * created store before releasing the lock, so the next caller in line always finds a bound witness.
 */
export async function resolveStoreBindingLocked(
  sql: Sql,
  fga: OpenFgaClient,
  explicitStoreId: string | undefined,
): Promise<StoreBindingResult> {
  return sql.begin(async (tx) => {
    // A single, fixed key: this table has exactly one row to protect, so one lock covers it.
    await tx`SELECT pg_advisory_xact_lock(hashtext('adr253:openfga-store-binding'))`
    const locked = tx as unknown as Sql
    const result = await resolveStoreBinding({ fga, sql: locked, explicitStoreId })
    if (result.kind !== 'create') return result
    // §3.4a already confirmed the witness table exists (a `create` verdict cannot come from
    // `wait-for-migration`), and no other process can be mid-resolution while this lock is held.
    const { id } = await fga.createStore({ name: STORE_NAME })
    await writeWitness(locked, id)
    return { kind: 'bound', storeId: id, created: true }
  })
}
