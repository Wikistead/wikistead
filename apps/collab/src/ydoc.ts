// Ydoc persistence: load and store Y.Doc binary state in Postgres.
// All DB access goes through withTenant() so RLS applies; cross-tenant
// operations are blocked at the DB level and detected via 0-row result.
import * as Y from 'yjs'
import { withTenant } from './db.js'

// Decode the canonical markdown from an encoded Y.Doc state — must match the API
// server's decodeYdocContent (both read the single 'content' Y.Text). Used to set
// has_unpublished_changes ACCURATELY (vs the published snapshot) on each persist.
function decodeContent(state: Uint8Array): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText('content').toString()
}

// #120 / ADR-040 (option 2): tombstone compaction. Repeated restores (delete-all + insert, append-only)
// grow pages.ydoc with STRUCTURAL deletion markers (item id/clock) even though gc:true reclaims the
// deleted CONTENT. A true compaction = re-encode a FRESH doc from the current text, dropping the
// tombstones. This changes the internal client-id/clock, so a client still holding the OLD doc could
// not merge it (desync) — it is therefore ONLY safe when NO client is connected. The caller (collab
// fetch/onLoadDocument) runs this exactly at load, before any client is served, and only when the
// document is not already open (see index.ts). PURE (real Yjs, no DB) → unit-testable.
//
// Returns a compacted state ONLY when it is worth it: the stored state is large (over MIN_BYTES) AND
// re-encoding shrinks it meaningfully (<= SHRINK_RATIO of the original). Otherwise null (leave as-is,
// so a normal doc with few tombstones is never needlessly rewritten). The content is preserved exactly
// (single 'content' Y.Text — the canonical form; round-trip identical).
const COMPACT_MIN_BYTES = 128 * 1024 // don't bother compacting small docs (tombstone overhead is minor)
const COMPACT_SHRINK_RATIO = 0.75 // only replace when the re-encode is a real win (drops enough tombstones)
export function compactIfBloated(state: Uint8Array): Uint8Array | null {
  if (state.length < COMPACT_MIN_BYTES) return null
  const src = new Y.Doc()
  let compacted: Uint8Array
  try {
    Y.applyUpdate(src, state)
    const text = src.getText('content').toString()
    const fresh = new Y.Doc()
    try {
      fresh.getText('content').insert(0, text) // fresh baseline — no delete tombstones
      compacted = Y.encodeStateAsUpdate(fresh)
    } finally {
      fresh.destroy()
    }
  } finally {
    src.destroy()
  }
  return compacted.length <= state.length * COMPACT_SHRINK_RATIO ? compacted : null
}

export async function loadYdoc(tenantId: string, pageId: string): Promise<Uint8Array | null> {
  let result: Uint8Array | null = null
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx<[{ ydoc: Buffer | null }]>`
      SELECT ydoc FROM pages WHERE id = ${pageId}
    `
    if (row?.ydoc) result = new Uint8Array(row.ydoc)
    return undefined
  })
  return result
}

export interface StoreResult {
  stored: boolean
  // ADR-088 / #186: set when the write was REFUSED because it was an unloaded empty flush that would
  // have wiped a non-empty page (distinct from a 0-row RLS/missing failure — here the row is kept).
  blocked?: boolean
}

// ADR-088 / #186: is `incomingState` an UNLOADED empty flush over the (non-empty) `existingState`?
// A writer that LOADED the existing doc and then cleared it carries the delete operations for the
// existing content, so merging existing ⊕ incoming yields EMPTY (a real select-all-delete → ALLOW).
// A fresh writer that never loaded it (init race / a bug producing an empty encode / a new doc
// autosaving over a real page) has no such deletes, so the merge KEEPS the existing content (an
// unloaded flush → REJECT: it would silently wipe the page). Distinguishes by Yjs CAUSALITY (the
// merge result), NOT byte length — so a legitimate clear is allowed while a blind wipe is blocked.
// PURE (real Yjs, no DB) → unit-testable. Returns false unless it is genuinely the dangerous
// transition (incoming decodes empty AND existing is non-empty AND the merge stays non-empty).
export function isUnloadedEmptyFlush(existingState: Uint8Array, incomingState: Uint8Array): boolean {
  if (decodeContent(incomingState) !== '') return false // incoming isn't empty → not a wipe
  const merged = new Y.Doc()
  try {
    Y.applyUpdate(merged, existingState)
    if (merged.getText('content').toString() === '') return false // existing already empty → nothing to lose
    Y.applyUpdate(merged, incomingState) // apply the writer's state ON TOP of the existing content
    // Still non-empty ⇒ the incoming state did NOT delete the existing content ⇒ the writer never
    // observed it ⇒ unloaded flush. Empty ⇒ the writer's own deletes removed it ⇒ a real clear.
    return merged.getText('content').toString() !== ''
  } finally {
    merged.destroy()
  }
}

// #114 / ADR-058: bounded, idempotent retry for a 0-row UPDATE. A 0-row write has TWO causes that are
// INDISTINGUISHABLE under RLS — the page was deleted, or a transient RLS/replication gap — and we must
// NOT superuser-bypass to tell them apart (that would break tenant isolation; RLS stays a defense-in-
// depth invariant). So we retry a BOUNDED number of times with exponential backoff + full jitter: a
// transient cause rides out, a permanently-deleted page simply exhausts the budget (a mid-session
// delete can never loop forever). Each retry re-applies the SAME captured `state` (the storeYdoc arg) —
// a newer edit is a separate storeYdoc call with its own state, so an old retry never stomps new state.
// On exhaustion storeYdoc returns {stored:false} so the caller disconnects the client (edits are not
// silently dropped) and a stable structured marker (no PII) is logged for alerting. A THROWN DB error
// (lost connection, etc.) is a DISTINCT path — it propagates, separating explicit errors from the
// silent 0-row case. The write is idempotent (UPDATE to a fixed state), so a retry after a partial
// success is harmless.
const STORE_MAX_RETRIES = 3 // up to 4 attempts total (1 + 3 retries)
// First-defense delay; grows 500 → 1000 → 2000 (× full jitter). Read at CALL time from the env so tests
// can shrink it (and ops can tune it) without touching the retry semantics; default is the 500ms design.
function storeBackoffMs(retry: number): number {
  const base = Number(process.env.YDOC_STORE_BACKOFF_MS ?? 500)
  const ceil = base * 2 ** (retry - 1) // retry 1→base, 2→2×, 3→4×
  return ceil / 2 + Math.random() * (ceil / 2) // full jitter in [ceil/2, ceil] — de-synchronises retriers
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type WriteOutcome = 'stored' | 'blocked' | 'zero_row'

// One write attempt inside a tenant-scoped transaction. Returns a discriminated outcome so the retry
// loop can distinguish a terminal empty-overwrite refusal ('blocked') from a retryable 'zero_row'. A
// DB error THROWS out of here (not caught) — the caller treats that as the separate error path.
async function attemptWrite(tenantId: string, pageId: string, state: Uint8Array, md: string): Promise<WriteOutcome> {
  return withTenant(tenantId, async (tx): Promise<WriteOutcome> => {
    // Empty-overwrite guard (ADR-088 / #186): only an EMPTY incoming state can wipe a page, so the extra
    // read + causal check run SOLELY on that (rare) branch — a normal non-empty write skips all of it.
    if (md === '') {
      const [existing] = await tx<[{ ydoc: Buffer | null }]>`SELECT ydoc FROM pages WHERE id = ${pageId}`
      if (existing?.ydoc && existing.ydoc.length > 0 && isUnloadedEmptyFlush(new Uint8Array(existing.ydoc), state)) {
        console.error(
          `event=ydoc_empty_overwrite_blocked tenant=${tenantId} page=${pageId}` +
          ` reason=unloaded_empty_flush_over_nonempty — kept existing bytes (no data loss)`,
        )
        return 'blocked' // existing ydoc untouched; terminal (never retried)
      }
    }
    const result = await tx`
      UPDATE pages
      SET ydoc = ${Buffer.from(state)}, updated_at = now(),
          has_unpublished_changes = (published_md IS DISTINCT FROM ${md})
      WHERE id = ${pageId}
    `
    return result.count === 0 ? 'zero_row' : 'stored'
  })
}

// Save ydoc binary to Postgres and (conditionally) create a revision snapshot.
//
// Draft-only persistence (draft/publish model): this autosaves the live draft
// (pages.ydoc) so edits survive a tab close / restart. It deliberately does NOT
// create revisions or reindex search — those are tied to an explicit publish
// (POST /pages/:id/publish), so history is the publish history and search/export
// only ever reflect PUBLISHED content. A draft's in-progress text is never indexed.
//
// has_unpublished_changes is set ACCURATELY (draft md != published_md), not always
// true: a persist of content that already equals the published version must NOT raise
// the badge. This is what makes "publish, then the trailing debounced store fires"
// leave the badge cleared (the store sees draft == published → false) instead of
// re-raising a spurious "unpublished changes". See the publish flush in the API.
export async function storeYdoc(
  tenantId: string,
  pageId: string,
  state: Uint8Array,
  _createdBy?: string,
): Promise<StoreResult> {
  const md = decodeContent(state)
  // Attempt + bounded retry ONLY on 'zero_row' (a transient RLS/replication gap rides out; a deleted
  // page exhausts the budget without an infinite loop). 'blocked' (empty-overwrite) is terminal. A
  // thrown DB error propagates (the separate error path). See the ADR-058 / #114 note above.
  for (let attempt = 0; attempt <= STORE_MAX_RETRIES; attempt++) {
    if (attempt > 0) await delay(storeBackoffMs(attempt))
    const outcome = await attemptWrite(tenantId, pageId, state, md)
    if (outcome === 'stored') return { stored: true }
    if (outcome === 'blocked') return { stored: false, blocked: true }
    // 'zero_row' → fall through to the next attempt (or exhaust)
  }
  // Retries exhausted: the write persistently affected 0 rows. Do NOT advance any persisted checkpoint
  // (pages.ydoc is unchanged — the UPDATE hit 0 rows). Surface {stored:false} so the caller disconnects
  // the client instead of silently dropping its edits. Stable structured marker (no PII) for alerting.
  console.error(
    `event=ydoc_store_0row_exhausted tenant=${tenantId} page=${pageId} attempts=${STORE_MAX_RETRIES + 1}` +
    ` reason=page_deleted_or_rls_mismatch — edits NOT persisted (retries exhausted); client will be disconnected`,
  )
  return { stored: false }
}
