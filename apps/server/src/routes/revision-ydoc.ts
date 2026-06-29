import { randomUUID } from 'node:crypto'
import type { StorageDriver } from '../storage/index.js'

// Revision ydoc offload (#113 / ADR-062). New revisions store their Y.Doc bytes in object
// storage and keep only a tenant-namespaced pointer (revisions.ydoc_key); legacy rows keep
// inline bytes and are read via dual-read. This module is the single home of both paths.

// Tenant-namespaced storage key for a revision blob. A random suffix (not the revision id)
// keeps the offload independent of DB id generation; GC diffs the live key SET, so structure
// doesn't matter — only tenant-prefixing (isolation) and uniqueness do.
export function revisionYdocKey(tenantId: string): string {
  return `revisions/${tenantId}/${randomUUID()}`
}

// Offload bytes to storage, S3 FIRST (ADR-062 write ordering). Returns the key; the caller
// writes it to the row AFTER this resolves. A put failure throws here so NO key is persisted —
// the worst case is an orphan blob (GC reclaims it), never a dangling pointer (DB key, no blob).
export async function storeRevisionYdoc(storage: StorageDriver, tenantId: string, bytes: Uint8Array): Promise<string> {
  const key = revisionYdocKey(tenantId)
  await storage.putObject(key, bytes, 'application/octet-stream')
  return key
}

// Dual-read (ADR-062): bytes come from ydoc_key (storage) if set, else the inline ydoc (legacy).
// A key set but the object missing is a dangling pointer — thrown LOUDLY (never silent; same
// discipline as #114). getObject is auth-bypassing, so the CALLER must already have authorized
// the revision's page (the existing view/edit gates on the revision routes do this).
export async function readRevisionYdoc(
  storage: StorageDriver,
  row: { ydoc: Buffer | null; ydoc_key: string | null },
): Promise<Uint8Array> {
  if (row.ydoc_key) {
    try {
      return await storage.getObject(row.ydoc_key)
    } catch (e) {
      throw Object.assign(new Error(`revision blob missing for key ${row.ydoc_key}`), {
        statusCode: 500, code: 'revision_blob_missing', cause: e,
      })
    }
  }
  if (row.ydoc) return new Uint8Array(row.ydoc)
  throw Object.assign(new Error('revision row has neither ydoc nor ydoc_key'), { statusCode: 500, code: 'revision_no_bytes' })
}
