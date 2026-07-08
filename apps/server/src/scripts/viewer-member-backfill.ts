// #258 / ADR-110: backfill `space:S#viewer_member@<member>` for every space member that predates the
// viewer_member relation. Run: `pnpm --filter @wikistead/server viewer-member:backfill`.
//
// Before this, `template#view` inherited `viewer from space` — which includes the public wildcard
// (`user:*`) and `share_link` — so a public / share-linked space leaked its space-scoped templates to
// anon / guests. `view` now inherits the member-only `viewer_member from space`, and the space-grant
// write path (spaceGrantTuples) writes viewer_member for NEW member VIEW grants. EXISTING member grants
// carry only `viewer` until this runs, so they'd lose template visibility until re-granted.
//
// SHOULD run in the SAME deploy as the model change so existing members keep seeing their space
// templates. Idempotent (skips members already carrying viewer_member) and safe to re-run. It NEVER
// copies `user:*` / `share_link` (that would re-introduce the leak). Reads FGA directly; needs the admin
// DB pool only to enumerate the space ids.
import postgres from 'postgres'
import { fgaClient } from '@wikistead/authz'
import { backfillSpaceViewerMembers } from '../routes/spaces.js'

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const rows = await adminPool<{ id: string }[]>`SELECT id FROM spaces`
    const written = await backfillSpaceViewerMembers(fgaClient, rows.map((r) => r.id))
    console.log(`viewer-member:backfill — enumerated ${rows.length} space(s), wrote ${written} viewer_member tuple(s)`)
  } finally {
    await adminPool.end()
  }
}
