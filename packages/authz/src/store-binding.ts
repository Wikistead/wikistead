// ADR-253 §3.4: a store is created only when the product has never had one — and the product
// remembers. This is the DECISION only — no IO. The witness row, the store listing, and each
// candidate's liveness are all asked for by the caller and handed in here as already-known facts,
// the same separation `migrations-dir.ts`'s `pickMigrationsDir` keeps between "where to look" and
// "what is actually there".

/** What the witness table says: this deployment has never bound a store, or it named one. */
export type Witness = { storeId: string } | null

/**
 * What this boot would use if the witness raised no objection — §3.1's explicit id (no listing),
 * or §3.3's unique name match. `'none'` means no explicit id and no store found by that name; §3.3's
 * ambiguity (more than one store with the name) is refused before reaching this decision at all —
 * "pinning is the way through ambiguity and never through the witness" (ADR-253 §3.3).
 */
export type Candidate = { storeId: string } | 'none'

export type StoreBindingOutcome =
  // Witness absent, a store was found (or explicitly named) and it is alive: bind to it and write
  // the witness row for the first time.
  | { kind: 'adopt'; storeId: string }
  // Witness already names this exact store, and it is alive: nothing to write.
  | { kind: 'proceed'; storeId: string }
  // Witness absent, no candidate at all: the caller may create a new store (subject to §3.4a — the
  // witness table itself has to exist, i.e. migrations have run).
  | { kind: 'create' }
  // Every other combination refuses. `reason` names one of the three distinct shapes ADR-253 §3.4
  // spells out, so the message an operator reads matches which mistake they actually made.
  | { kind: 'refuse'; reason: RefusalReason }

export type RefusalReason =
  // absent witness, an explicitly-named or uniquely-found store that no longer exists. A typo or a
  // retired id in a manifest is not a first install.
  | { shape: 'named-candidate-gone'; storeId: string }
  // witness names a store, and NOTHING else about this boot disagrees — but that store is gone.
  // "the datastore was lost", naming the store that used to be there.
  | { shape: 'witness-store-lost'; witnessStoreId: string }
  // witness names one store, this boot would use a DIFFERENT one, and that other one is alive: a
  // deployment repointed at another store, or a database restored from elsewhere.
  | { shape: 'witness-mismatch'; witnessStoreId: string; candidateStoreId: string }
  // witness names one store, this boot would use a different one, and NEITHER is known to be alive:
  // the message says both facts, because merging them destroys the distinction between "wrong
  // address" and "lost datastore" ADR-253 §3.4 exists to keep.
  | { shape: 'witness-mismatch-both-gone'; witnessStoreId: string; candidateStoreId: string }

/**
 * @param candidateIsLive Whether `candidate`'s store still exists. `null` iff `candidate === 'none'`
 *   (there is nothing to check).
 * @param witnessStoreIsLive Whether `witness`'s store still exists, checked independently of
 *   `candidateIsLive` — the two ids can differ, and ADR-253 §3.4's last row needs both facts. `null`
 *   iff `witness === null`.
 */
export function decideStoreBinding(input: {
  witness: Witness
  candidate: Candidate
  candidateIsLive: boolean | null
  witnessStoreIsLive: boolean | null
}): StoreBindingOutcome {
  const { witness, candidate, candidateIsLive, witnessStoreIsLive } = input

  if (witness === null) {
    if (candidate === 'none') return { kind: 'create' }
    if (candidateIsLive) return { kind: 'adopt', storeId: candidate.storeId }
    return { kind: 'refuse', reason: { shape: 'named-candidate-gone', storeId: candidate.storeId } }
  }

  // Witness bound. `candidate === 'none'` under a bound witness means no store named `wikistead`
  // exists anywhere — which, since a store's name never changes after creation in this design, can
  // only mean the witness's own store is gone: the same conclusion as an explicit mismatch that
  // resolves to nothing.
  if (candidate === 'none') {
    return { kind: 'refuse', reason: { shape: 'witness-store-lost', witnessStoreId: witness.storeId } }
  }

  if (candidate.storeId === witness.storeId) {
    if (candidateIsLive) return { kind: 'proceed', storeId: witness.storeId }
    return { kind: 'refuse', reason: { shape: 'witness-store-lost', witnessStoreId: witness.storeId } }
  }

  // Mismatch: this boot would use a store the witness does not name.
  if (candidateIsLive) {
    return {
      kind: 'refuse',
      reason: { shape: 'witness-mismatch', witnessStoreId: witness.storeId, candidateStoreId: candidate.storeId },
    }
  }
  if (witnessStoreIsLive === false) {
    return {
      kind: 'refuse',
      reason: {
        shape: 'witness-mismatch-both-gone',
        witnessStoreId: witness.storeId,
        candidateStoreId: candidate.storeId,
      },
    }
  }
  // The candidate is gone and the witness's own store's liveness was not asked (or came back live) —
  // still a mismatch, and still a refusal; the caller loses only the "both facts" wording, never the
  // refusal itself.
  return {
    kind: 'refuse',
    reason: { shape: 'witness-mismatch', witnessStoreId: witness.storeId, candidateStoreId: candidate.storeId },
  }
}

/** The message an operator reads. Kept separate from the decision so the two are tested apart. */
export function describeRefusal(reason: RefusalReason): string {
  switch (reason.shape) {
    case 'named-candidate-gone':
      return (
        `store ${reason.storeId} does not exist — a typo or a retired id is not a first install ` +
        `(ADR-253 §3.4)`
      )
    case 'witness-store-lost':
      return (
        `this deployment was bound to store ${reason.witnessStoreId}, which no longer exists — the ` +
        `datastore was lost (ADR-253 §3.4)`
      )
    case 'witness-mismatch':
      return (
        `this deployment is bound to store ${reason.witnessStoreId}, but is pointed at store ` +
        `${reason.candidateStoreId} — a deployment repointed at another store, or a database ` +
        `restored from elsewhere (ADR-253 §3.4)`
      )
    case 'witness-mismatch-both-gone':
      return (
        `this deployment is bound to store ${reason.witnessStoreId} (absent) but pointed at store ` +
        `${reason.candidateStoreId} (also absent) — neither exists (ADR-253 §3.4)`
      )
  }
}
