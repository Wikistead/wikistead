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

// Save ydoc binary to Postgres and (conditionally) create a revision snapshot.
//
// 0-row UPDATE detection: RLS or a deleted/missing page causes the UPDATE
// to affect 0 rows. When stored=false: error is logged and pages.ydoc is not
// written. The retry + alert mechanism for persistent 0-row failures is designed
// in ADR-058 / #114 (bounded retry + a stable structured failure marker; the store
// callback stops swallowing the result) — pending approval, not yet implemented.
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
  let stored = false
  let blocked = false
  const md = decodeContent(state)
  await withTenant(tenantId, async (tx) => {
    // Empty-overwrite guard (ADR-088 / #186): an EMPTY incoming state is the ONLY thing that can wipe a
    // page, so the extra read + causal check run SOLELY on that (rare) branch — a normal non-empty write
    // skips all of it (zero hot-path overhead beyond this emptiness check, per the ADR-088 review note).
    if (md === '') {
      const [existing] = await tx<[{ ydoc: Buffer | null }]>`SELECT ydoc FROM pages WHERE id = ${pageId}`
      if (existing?.ydoc && existing.ydoc.length > 0 && isUnloadedEmptyFlush(new Uint8Array(existing.ydoc), state)) {
        // The writer never observed the existing content — persisting its empty state would silently
        // wipe the page. REFUSE and keep the existing bytes; emit the LOUD marker (ADR-058 style, no PII).
        console.error(
          `event=ydoc_empty_overwrite_blocked tenant=${tenantId} page=${pageId}` +
          ` reason=unloaded_empty_flush_over_nonempty — kept existing bytes (no data loss)`,
        )
        blocked = true
        return undefined // existing ydoc untouched; stored stays false
      }
    }
    const result = await tx`
      UPDATE pages
      SET ydoc = ${Buffer.from(state)}, updated_at = now(),
          has_unpublished_changes = (published_md IS DISTINCT FROM ${md})
      WHERE id = ${pageId}
    `
    if (result.count === 0) {
      console.error(
        `[ydoc:store] 0-row UPDATE page:${pageId} tenant:${tenantId}` +
        ` — page not found or RLS mismatch; edits will NOT survive restart`,
      )
      return undefined
    }
    stored = true
    return undefined
  })
  return { stored, blocked }
}
