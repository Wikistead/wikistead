// Reconciling GC for offloaded revision blobs (#113 / ADR-062): `pnpm revisions:gc`.
//
// When a revision row is pruned (the count-prune trigger, migration 027) or its page is
// deleted (FK cascade), the DB pointer vanishes but the S3 object remains — an orphan blob.
// A DB trigger can't reach S3, so a reconciling GC reclaims them. The crux is NOT deleting a
// REFERENCED blob: GC diffs storage against the full live `ydoc_key` set and deletes in TWO
// stages with a grace window —
//   stage 1 (mark):   a storage object with no live pointer is recorded (first_seen).
//   stage 2 (delete): on a later run, if it is STILL orphan AND first_seen is past `grace`,
//                     delete the object + clear the mark. A candidate that became live again
//                     (or whose blob is gone) is un-marked.
// So a just-written blob (key put, row not yet committed) is safe: by the next run its row is
// committed → it is live → un-marked, never deleted. Cross-tenant (admin role bypasses RLS),
// idempotent (a missing deleteObject is a no-op).
import postgres from 'postgres'
import { LogicalStorageDriver } from '../storage/index.js'
import type { StorageDriver } from '../storage/index.js'

const DEFAULT_GRACE_SECONDS = 24 * 60 * 60
const REVISION_PREFIX = 'revisions/'

export async function runRevisionGc(
  sql: postgres.Sql,
  storage: StorageDriver,
  opts: { graceSeconds?: number; now?: number } = {},
): Promise<{ marked: number; deleted: number }> {
  const grace = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS
  const now = opts.now ?? Date.now()

  const objects = await storage.listObjects(REVISION_PREFIX)
  const liveRows = await sql<{ ydoc_key: string }[]>`SELECT ydoc_key FROM revisions WHERE ydoc_key IS NOT NULL`
  const live = new Set(liveRows.map((r) => r.ydoc_key))
  const orphanNow = new Set(objects.filter((k) => !live.has(k)))

  // Stage 1 — mark: record any currently-orphan object (keep the earliest first_seen).
  for (const key of orphanNow) {
    await sql`INSERT INTO revision_gc_candidates (ydoc_key) VALUES (${key}) ON CONFLICT (ydoc_key) DO NOTHING`
  }

  // Stage 2 — resolve each existing candidate.
  const candidates = await sql<{ ydoc_key: string; first_seen: Date }[]>`SELECT ydoc_key, first_seen FROM revision_gc_candidates`
  let deleted = 0
  for (const c of candidates) {
    if (!orphanNow.has(c.ydoc_key)) {
      // No longer orphan (became live again, or the object is already gone) → un-mark.
      await sql`DELETE FROM revision_gc_candidates WHERE ydoc_key = ${c.ydoc_key}`
      continue
    }
    // Still orphan: delete only once it has been orphan since BEFORE the grace window.
    if (c.first_seen.getTime() <= now - grace * 1000) {
      await storage.deleteObject(c.ydoc_key).catch(() => {}) // idempotent
      await sql`DELETE FROM revision_gc_candidates WHERE ydoc_key = ${c.ydoc_key}`
      deleted++
    }
  }
  return { marked: orphanNow.size, deleted }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const { marked, deleted } = await runRevisionGc(adminPool, new LogicalStorageDriver())
    console.log(`revisions:gc — ${marked} orphan candidate(s) seen, ${deleted} deleted`)
  } finally {
    await adminPool.end()
  }
}
