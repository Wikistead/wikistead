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

// Subjects that are nobody, for a relation that answers about the OBJECT. `private` is granted to two
// typed wildcards — `[user:*, share_link:*]` — and a wildcard only matches its own type, so ONE probe
// answers for one half of the pair. Both are asked because a page privatised before #244's backfill
// holds only the guest half, and a DESCENDANT of such a page has no tuple of its own for the store read
// to find: measured, `share_link:` said private and `user:` said not, and the child was delivered.
// (Same idiom as `MOVE_PRIVATE_PROBE` in routes/pages.ts, which asks at the move boundary.)
const PRIVATE_PROBES = ['user:__disposition_private_probe__', 'share_link:__disposition_private_probe__']

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
    // The read is already paid for (it answers `linked` below), so a page with its own marker is
    // settled here without asking the store twice more. It is relation-only rather than
    // `private@user:*` — #228 review point 3 — which today catches exactly what the two probes below
    // catch, because `private` accepts only those two typed wildcards. It stays as the shape that
    // survives a third subject type being added to that list without this file being revisited.
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
    const answers = await Promise.all(
      PRIVATE_PROBES.map((user) => fga.check({ user, relation: 'private', object: `page:${pageId}` })),
    )
    // `!== false` rather than truthiness: the field is optional on the SDK's response, and an absent
    // answer is "I do not know", which on this question must not read as "not private".
    if (answers.some((a) => a.allowed !== false)) return 'suppress'
    return linked ? 'deliver' : 'not-ready'
  } catch { return 'suppress' } // fail closed
}
