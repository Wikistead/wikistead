import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check } from '@kb/authz'
import { pool } from '../db/pool.js'
import { makeS3Key } from '../storage/driver.js'
import type { StorageDriver } from '../storage/index.js'
import type { TenantDb } from '../db/index.js'

// Upload TTL: short enough to limit leaked-URL exposure, long enough for large files.
const PUT_TTL  = 15 * 60   // 15 minutes
// Download TTL: short (presigned URL is a bearer token — re-request on each view).
const GET_TTL  = 5  * 60   // 5 minutes

interface AttachmentRow {
  id: string; tenant_id: string; page_id: string
  filename: string; content_type: string; size_bytes: number | null
  s3_key: string; status: string; created_at: Date; confirmed_at: Date | null
}
export interface AttachmentSummary {
  id: string; filename: string; contentType: string
  sizeBytes: number | null; createdAt: Date
}

// ── Service functions ─────────────────────────────────────────────────────

// Presign a PUT URL for client-side direct upload. Creates a DB record
// with status='pending' (invisible to reads until confirmed).
// FGA check: edit on page (uploading is an edit-level operation).
// Known limitation: a presigned PUT URL, once issued, cannot be revoked
// before its TTL expires — S3 presigned URL semantics. TTL is set short
// to limit the exposure window.
export async function presignAttachment(
  db: TenantDb,
  storage: StorageDriver,
  fga: OpenFgaClient,
  args: { tenantId: string; pageId: string; userId: string; filename: string; contentType: string },
): Promise<{ attachmentId: string; uploadUrl: string; expiresAt: string }> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Pre-generate the UUID so we can include it in the S3 key before INSERT.
  const [{ id }] = await db.sql<[{ id: string }]>`SELECT gen_random_uuid()::text AS id`
  const s3Key = makeS3Key(args.tenantId, args.pageId, id, args.filename)
  await db.sql`
    INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status)
    VALUES (${id}, ${args.tenantId}, ${args.pageId}, ${args.filename}, ${args.contentType}, ${s3Key}, 'pending')
  `

  const uploadUrl = await storage.presignPut(s3Key, { contentType: args.contentType, ttlSeconds: PUT_TTL })
  const expiresAt = new Date(Date.now() + PUT_TTL * 1000).toISOString()
  return { attachmentId: id, uploadUrl, expiresAt }
}

// Confirm an upload. Server calls S3 HeadObject to get the actual size_bytes —
// client-supplied size is ignored to prevent tampering and to provide a trustworthy
// basis for future storage quota enforcement.
// Status lifecycle: pending → confirmed.
// Returns 404 if id not found OR status is not 'pending'.
export async function confirmAttachment(
  db: TenantDb,
  storage: StorageDriver,
  args: { id: string; tenantId: string },
): Promise<AttachmentSummary & { downloadUrl: string }> {
  const [row] = await db.sql<AttachmentRow[]>`
    SELECT * FROM attachments WHERE id = ${args.id} AND status = 'pending'
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  let sizeBytes: number
  try {
    const head = await storage.headObject(row.s3_key)
    sizeBytes = head.sizeBytes
  } catch {
    throw Object.assign(new Error('upload not found in storage; upload to the presigned URL first'), { statusCode: 400 })
  }

  await db.sql`
    UPDATE attachments
    SET status = 'confirmed', size_bytes = ${sizeBytes}, confirmed_at = now()
    WHERE id = ${args.id}
  `
  const downloadUrl = await storage.presignGet(row.s3_key, { ttlSeconds: GET_TTL })
  return { id: row.id, filename: row.filename, contentType: row.content_type, sizeBytes, createdAt: row.created_at, downloadUrl }
}

// Return a presigned GET URL for a confirmed attachment.
// Status rules enforced here:
//   pending → 404 (upload not yet complete; treat as not found)
//   deleted → 410 Gone (explicitly removed)
//   confirmed → issue presigned GET
// FGA check: view on page.
export async function downloadAttachment(
  db: TenantDb,
  storage: StorageDriver,
  fga: OpenFgaClient,
  args: { id: string; userId: string },
): Promise<{ downloadUrl: string; filename: string; expiresAt: string }> {
  const [row] = await db.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${args.id}`
  if (!row || row.status === 'pending') throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (row.status === 'deleted') throw Object.assign(new Error('gone'), { statusCode: 410 })

  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: row.page_id })
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const downloadUrl = await storage.presignGet(row.s3_key, { ttlSeconds: GET_TTL })
  return { downloadUrl, filename: row.filename, expiresAt: new Date(Date.now() + GET_TTL * 1000).toISOString() }
}

// List confirmed attachments for a page. pending and deleted are excluded.
// FGA check: view on page.
export async function listAttachments(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<AttachmentSummary[]> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const rows = await db.sql<AttachmentRow[]>`
    SELECT id, filename, content_type, size_bytes, created_at
    FROM attachments
    WHERE page_id = ${args.pageId} AND status = 'confirmed'
    ORDER BY created_at
  `
  return rows.map(r => ({ id: r.id, filename: r.filename, contentType: r.content_type, sizeBytes: r.size_bytes, createdAt: r.created_at }))
}

// Soft-delete an attachment. Fires S3 delete + physical DB delete asynchronously
// (at-least-once — same pattern as search_outbox). GC handles retry on failure.
// FGA check: manage on page.
// Status rules: pending/confirmed → soft-delete; already deleted → idempotent 204.
export async function deleteAttachment(
  db: TenantDb,
  storage: StorageDriver,
  fga: OpenFgaClient,
  args: { id: string; userId: string },
): Promise<void> {
  const [row] = await db.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${args.id}`
  if (!row || row.status === 'deleted') return  // not found or already deleted → idempotent

  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: row.page_id })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Soft delete first (visible effect is immediate — row disappears from reads).
  await db.sql`UPDATE attachments SET status = 'deleted' WHERE id = ${args.id}`

  // Fire-and-forget: S3 delete → physical DB delete.
  // If S3 or DB delete fails, status='deleted' remains and GC retries.
  // at-least-once: deleteObject is idempotent (no-op for missing keys).
  const { s3_key: s3Key, tenant_id: tenantId } = row
  void (async () => {
    try {
      await storage.deleteObject(s3Key)
      await pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        await tx`DELETE FROM attachments WHERE id = ${args.id}`
      })
    } catch {
      // Leave status='deleted' for GC to handle.
    }
  })()
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function attachmentsPlugin(app: FastifyInstance) {
  type PresignBody = { filename: string; contentType: string }
  app.post<{ Params: { spaceId: string; pageId: string }; Body: PresignBody }>(
    '/spaces/:spaceId/pages/:pageId/attachments/presign',
    async (req, reply) => {
      const result = await presignAttachment(req.db, app.storageDriver, app.fga, {
        tenantId: req.tenant.id,
        pageId: req.params.pageId,
        userId: req.user.sub,
        filename: req.body.filename,
        contentType: req.body.contentType,
      })
      return reply.code(201).send(result)
    },
  )

  app.get<{ Params: { spaceId: string; pageId: string } }>(
    '/spaces/:spaceId/pages/:pageId/attachments',
    async (req) => listAttachments(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub }),
  )

  app.post<{ Params: { id: string } }>('/attachments/:id/confirm', async (req) => {
    return confirmAttachment(req.db, app.storageDriver, { id: req.params.id, tenantId: req.tenant.id })
  })

  app.get<{ Params: { id: string } }>('/attachments/:id/download', async (req, reply) => {
    const result = await downloadAttachment(req.db, app.storageDriver, app.fga, {
      id: req.params.id,
      userId: req.user.sub,
    })
    return reply.send(result)
  })

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    await deleteAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, userId: req.user.sub })
    return reply.code(204).send()
  })
}
