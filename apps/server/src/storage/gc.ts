// Storage GC: reclaims orphaned and soft-deleted attachments.
// Run manually or via a scheduled job: pnpm --filter @wikistead/server storage:gc
//
// Two patterns (same philosophy as search_outbox — DB is the source of truth):
//
//   pending > 1h  → upload was never completed by the client.
//                   S3 object may or may not exist; deleteObject is a no-op either way.
//                   Physical DB delete safe: status never became 'confirmed'.
//
//   deleted       → soft-deleted by the application. S3 delete + physical DB delete
//                   may have been deferred if the async path failed. GC retries.
//                   at-least-once: deleteObject is idempotent (no-op for missing keys).

import postgres from 'postgres'
import type { StorageDriver } from './driver.js'

export async function runStorageGc(storage: StorageDriver): Promise<void> {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    // Stale pending: created > 1 hour ago, never confirmed.
    const stale = await adminPool<{ id: string; s3_key: string }[]>`
      SELECT id, s3_key FROM attachments
      WHERE status = 'pending' AND created_at < now() - INTERVAL '1 hour'
    `
    for (const { id, s3_key } of stale) {
      try { await storage.deleteObject(s3_key) } catch {}
      await adminPool`DELETE FROM attachments WHERE id = ${id}`
      console.log(`gc: removed stale pending ${id}`)
    }

    // Soft-deleted: S3 delete may not have run yet.
    const deleted = await adminPool<{ id: string; s3_key: string }[]>`
      SELECT id, s3_key FROM attachments WHERE status = 'deleted'
    `
    for (const { id, s3_key } of deleted) {
      try {
        await storage.deleteObject(s3_key)
        await adminPool`DELETE FROM attachments WHERE id = ${id}`
        console.log(`gc: cleaned up deleted ${id}`)
      } catch {
        console.error(`gc: failed to clean ${id}, will retry next run`)
      }
    }
  } finally {
    await adminPool.end()
  }
}

// Script entry point: pnpm --filter @wikistead/server storage:gc
if (import.meta.url === `file://${process.argv[1]}`) {
  const { LogicalStorageDriver } = await import('./driver.js')
  const storage = new LogicalStorageDriver()
  await runStorageGc(storage)
  console.log('gc complete')
}
