// #244 / ADR-098 addendum: backfill `private@share_link:*` onto every page that already carries
// `private@user:*`. Run: `pnpm --filter @wikistead/server private:backfill`.
//
// Before this, the per-page PRIVATE marker was `user:*` ONLY. OpenFGA's typed wildcard `user:*` matches
// only user-type principals, so a space share-link guest (share_link:Y) slipped past `... but not private`
// and could read private pages via `viewer from space`. The model now marks the PAIR (model.fga) and the
// write path (setPagePrivate) writes both — but EXISTING private pages carry only `user:*` until this runs.
//
// MUST run in the SAME deploy as the model change: a model-only deploy leaves every legacy private page
// still leaking to space-link guests. Idempotent (a page that already has share_link:* is skipped via the
// duplicate-write catch), cross-store nothing — it reads FGA directly, so it needs no DB and no RLS bypass.
import { fgaClient, writeTuples } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'

export async function backfillPrivateShareLink(fga: OpenFgaClient): Promise<{ scanned: number; added: number }> {
  let scanned = 0
  let added = 0
  let continuationToken: string | undefined
  // Read every `page:*#private@user:*` tuple (object is the TYPE prefix `page:` → all pages), paginated.
  do {
    const res = await fga.read(
      { user: 'user:*', relation: 'private', object: 'page:' },
      continuationToken ? { continuationToken } : undefined,
    )
    for (const t of res.tuples ?? []) {
      const object = t.key?.object
      if (!object) continue
      scanned++
      // Idempotent add: writing a share_link:* tuple that already exists throws (OpenFGA rejects a
      // duplicate); catch + skip so a re-run is a no-op. A single-tuple write can't be partially applied.
      try {
        await writeTuples(fga, [{ user: 'share_link:*', relation: 'private', object }])
        added++
      } catch {
        /* share_link:* already present — already backfilled */
      }
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return { scanned, added }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { scanned, added } = await backfillPrivateShareLink(fgaClient)
  console.log(`private:backfill scanned ${scanned} private page(s), added share_link:* to ${added}`)
}
