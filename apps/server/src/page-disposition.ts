// #228 comment 1000, extracted for #547 (ADR-196 §4 R1): the ONE page-level delivery disposition both
// out-of-fortress channels (webhooks, email) share. An event about a PRIVATE or UNPUBLISHED-DRAFT page
// must not be delivered — its pageId/actor would leak the existence the 404-uniform surface hides.
// Tri-state so a drain can tell a hard-suppress from a transient not-yet-linked page:
//   'suppress'  — a `private` marker is present: drop immediately, never deliver (existence-hiding).
//   'deliver'   — has a `page#space` tuple (published / space-linked) and no private marker.
//   'not-ready' — neither: a `page.published` whose page#space FGA write hasn't landed yet (it is
//                 written AFTER the publish tx commits, so an outbox row can briefly out-race it), OR a
//                 genuine draft event. The CALLER owns what this means: webhooks retry with backoff
//                 (#228 review point 2); the mention EMAIL maps it to suppress (ADR-196 §4 R2 — a draft
//                 mention stays in-app deterministically, never a timing-dependent send).
// Non-page events are always 'deliver'. Fails CLOSED to 'suppress' on any FGA error.
import type { OpenFgaClient } from '@openfga/sdk'
import { readObjectTuples } from '@wikistead/authz'

export type EventDisposition = 'suppress' | 'deliver' | 'not-ready'

// A subject that is nobody, for a relation that answers about the OBJECT. `private` is granted to the
// typed wildcard `[user:*]`, so any user id answers "is this page private" — the same idiom as
// `MOVE_PRIVATE_PROBE` in routes/pages.ts, which asks the same question at the move boundary.
const PRIVATE_PROBE = 'user:__disposition_private_probe__'

export async function pageEventDisposition(fga: OpenFgaClient, payload: Record<string, unknown>): Promise<EventDisposition> {
  const pageId = typeof payload.pageId === 'string' ? payload.pageId : (payload.resource as { type?: string; id?: string } | undefined)?.id
  if (!pageId) return 'deliver' // not a page event → no instance-level exclusion
  try {
    // #553 re-review: paginated. A bare read answers ONE page (50) and truncates silently — on a page
    // with many grants the `private` marker could fall off it, and this function would answer
    // 'deliver' for a PRIVATE page. Every other branch here fails toward suppression; the read itself
    // must not be the one place that fails open.
    const rel = await readObjectTuples(fga, `page:${pageId}`)
    const linked = rel.some((k) => k.relation === 'space') // page#space → published/space-linked (not a draft)
    // #228 review point 3: suppress on ANY `private` marker, not just `private@user:*`. The model writes
    // private as the pair [user:*, share_link:*] (model.fga) — relation-only is strictly more defensive
    // (fail toward suppression).
    const priv = rel.some((k) => k.relation === 'private')
    if (priv) return 'suppress'
    // ⚠️ #862 the read above sees STORED tuples, and `private` is
    // `[user:*, share_link:*] or private from parent` (model.fga) — so a page whose privacy is
    // INHERITED has no tuple of its own and this function answered `deliver` for it. Measured:
    // privatise a folder, and its child is `private = true` at the store while this said `deliver`.
    // ADR-103 decision 2b is explicit that privatising a folder makes its whole subtree private, and
    // the marker is written on the ROOT only, so the whole subtree was the leak.
    //
    // Asked with the client rather than through `checkRelation`, and that is the load-bearing part: the
    // primitive ANDs the ambient scope's restriction, and a restriction that cannot be resolved makes it
    // answer `false` — which HERE would read as "not private" and deliver. The polarity of every other
    // caller is the opposite of this one's. A throw lands in the catch below and suppresses.
    const { allowed } = await fga.check({ user: PRIVATE_PROBE, relation: 'private', object: `page:${pageId}` })
    if (allowed) return 'suppress'
    return linked ? 'deliver' : 'not-ready'
  } catch { return 'suppress' } // fail closed
}
