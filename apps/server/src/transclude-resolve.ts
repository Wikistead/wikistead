import type { OpenFgaClient } from '@openfga/sdk'
import type { CheckContext } from '@wikistead/authz'
import { sliceSectionBySlug } from '@wikistead/macro-render'
import { canViewPage } from './page-view-gate.js'
import type { TenantDb } from './db/index.js'

// Internal page-transclude resolution (#108 / ADR-071) — the internal counterpart to the external
// embed resolver. SECURITY: a viewer of host page A who transcludes page B must have `view` on B
// ITSELF (not merely on A) — else an IDENTICAL denied placeholder that leaks NOTHING (not B's
// existence, title, size, or count). The placeholder is the same whether B is unviewable,
// unpublished, or absent (no distinction = no oracle). Cycle/depth guarded so nested transclusion
// (B contains C) can't loop or run away. (Parsing the transclude refs out of page content is the
// macro layer; this resolves ONE ref with the authz + guard — the load-bearing security part.)

export const MAX_TRANSCLUDE_DEPTH = 5

// Should resolution STOP before visiting `next`? A page already in the chain → cycle; too deep →
// depth. Either ⇒ render the placeholder instead of recursing.
export function transcludeStop(chain: readonly string[], next: string): 'cycle' | 'depth' | null {
  if (chain.includes(next)) return 'cycle'
  if (chain.length >= MAX_TRANSCLUDE_DEPTH) return 'depth'
  return null
}

export type TranscludeResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'cycle' | 'depth' | 'denied' } // 'denied' = the existence-hiding placeholder

export async function resolveTranscludeRef(
  deps: { db: TenantDb; fga: OpenFgaClient },
  args: { principal: string; refPageId: string; chain?: readonly string[]; context?: CheckContext },
): Promise<TranscludeResult> {
  // #325 / ADR-137 §2.0: split the raw ref at the FIRST `#` into (bare page id, fragment) BEFORE any gate
  // machinery, so cycle/depth and the FGA `view` object both key on the bare page id — a fragment can never
  // smuggle a different identity into the cycle check or the authz object. Fragments add NO authz surface:
  // visibility is page-granular, so a page viewer may see any section (all fragment work is AFTER the gate).
  const hashIdx = args.refPageId.indexOf('#')
  const refPageId = hashIdx === -1 ? args.refPageId : args.refPageId.slice(0, hashIdx)
  const fragment = hashIdx === -1 ? null : args.refPageId.slice(hashIdx + 1)

  const chain = args.chain ?? []
  const stop = transcludeStop(chain, refPageId)
  if (stop) return { ok: false, reason: stop }

  // View re-check on the REFERENCED page (monotonic deny; the host page's view is not enough). A
  // guest's context carries time so an expired share-link denies. No view → identical placeholder.
  if (!(await canViewPage(deps.fga, args.principal, refPageId, args.context))) {
    return { ok: false, reason: 'denied' }
  }
  const [row] = await deps.db.sql<{ published_md: string | null }[]>`
    SELECT published_md FROM pages WHERE id = ${refPageId}`
  // Unpublished or absent → the SAME placeholder as unviewable (no existence/state distinction).
  if (!row?.published_md) return { ok: false, reason: 'denied' }
  if (!fragment) return { ok: true, content: row.published_md }

  // A fragment resolves ONLY after the page gate, so an unknown/unsupported fragment leaks nothing: it
  // returns the SAME 'denied' placeholder as an unviewable page (byte-identical — no fragment oracle).
  // slice 1 = `#<slug>` sections; `#^<id>` block refs are slice 2 (until then they resolve to 'denied').
  const sliced = fragment.startsWith('^') ? null : sliceSectionBySlug(row.published_md, fragment)
  if (sliced == null) return { ok: false, reason: 'denied' }
  return { ok: true, content: sliced }
}
