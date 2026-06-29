// Lazy backfill of legacy inline revision ydocs → object storage (#113 / ADR-062): a
// reconciling batch, `pnpm revisions:backfill`. New revisions already offload (publish/restore
// write ydoc_key). This migrates the OLD rows that still carry inline `ydoc` BYTEA, converging
// "inline count → 0" so the dual-read inline path can eventually be removed. No big-bang: run
// it in batches until `remaining` is 0; safe to re-run (each row migrates once).
//
// Ordering (ADR-062): put bytes to storage FIRST, then UPDATE the row to point at the key and
// NULL the inline bytes. A put-then-crash leaves an orphan blob (GC reclaims it), never a
// dangling pointer; the `ydoc_key IS NULL` guard on the UPDATE makes concurrent runs safe.
import postgres from 'postgres'
import { LogicalStorageDriver } from '../storage/index.js'
import type { StorageDriver } from '../storage/index.js'
import { storeRevisionYdoc } from '../routes/revision-ydoc.js'

export async function backfillRevisionYdoc(
  sql: postgres.Sql,
  storage: StorageDriver,
  opts: { batchSize?: number } = {},
): Promise<{ migrated: number; remaining: number }> {
  const batch = opts.batchSize ?? 100
  const rows = await sql<{ id: string; tenant_id: string; ydoc: Buffer }[]>`
    SELECT id, tenant_id, ydoc FROM revisions
    WHERE ydoc_key IS NULL AND ydoc IS NOT NULL
    LIMIT ${batch}
  `
  let migrated = 0
  for (const r of rows) {
    const key = await storeRevisionYdoc(storage, r.tenant_id, new Uint8Array(r.ydoc)) // S3 first
    // Point at the key + drop the inline bytes. The guard avoids racing a concurrent backfill;
    // the CHECK (ydoc OR ydoc_key) still holds because ydoc_key is now set.
    const res = await sql`UPDATE revisions SET ydoc_key = ${key}, ydoc = NULL WHERE id = ${r.id} AND ydoc_key IS NULL`
    if (res.count > 0) migrated++
  }
  const [rem] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM revisions WHERE ydoc_key IS NULL AND ydoc IS NOT NULL
  `
  return { migrated, remaining: rem.n }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  const storage = new LogicalStorageDriver()
  try {
    let total = 0
    let r: { migrated: number; remaining: number }
    do {
      r = await backfillRevisionYdoc(adminPool, storage)
      total += r.migrated
    } while (r.migrated > 0)
    console.log(`revisions:backfill — migrated ${total} inline revision(s); ${r.remaining} remaining`)
  } finally {
    await adminPool.end()
  }
}
