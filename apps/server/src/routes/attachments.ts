import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
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
  args: { tenantId: string; plan: string; pageId: string; userId: string; filename: string; contentType: string },
): Promise<{ attachmentId: string; uploadUrl: string; expiresAt: string }> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Plan-gated storage quota: sum of CONFIRMED attachment sizes for the tenant.
  // Pending uploads aren't counted until confirmed (size is unknown until then),
  // so concurrent presigns can overshoot slightly — same count+insert race class
  // as maxSpaces; acceptable for v1.
  const quota = resolveEntitlements(args.plan).maxStorageBytes
  if (isFinite(quota)) {
    const [{ used }] = await db.sql<[{ used: string }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS used
      FROM attachments WHERE tenant_id = ${args.tenantId} AND status = 'confirmed'
    `
    if (Number(used) >= quota) {
      throw Object.assign(new Error('storage quota exceeded'), { statusCode: 402 })
    }
  }

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
  args: { id: string; tenantId: string; userId: string },
): Promise<AttachmentSummary & { downloadUrl: string }> {
  const [row] = await db.sql<AttachmentRow[]>`
    SELECT * FROM attachments WHERE id = ${args.id} AND status = 'pending'
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  // HeadObject with a short retry: some S3 gateways (e.g. SeaweedFS) are not
  // strictly read-after-write consistent, so the object can be momentarily
  // un-HEAD-able right after the client's PUT returns 200. This only re-reads the
  // same key — it never creates another pending row, so it cannot grow orphans.
  let sizeBytes: number | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      sizeBytes = (await storage.headObject(row.s3_key)).sizeBytes
      break
    } catch {
      if (attempt < 4) await new Promise((r) => setTimeout(r, 150))
    }
  }
  if (sizeBytes === undefined) {
    throw Object.assign(new Error('upload not found in storage; upload to the presigned URL first'), { statusCode: 400 })
  }

  await db.sql`
    UPDATE attachments
    SET status = 'confirmed', size_bytes = ${sizeBytes}, confirmed_at = now()
    WHERE id = ${args.id}
  `
  const downloadUrl = await storage.presignGet(row.s3_key, { ttlSeconds: GET_TTL })
  emit({ type: 'attachment.confirmed', tenantId: args.tenantId, attachmentId: row.id, pageId: row.page_id, actorId: args.userId })
  return { id: row.id, filename: row.filename, contentType: row.content_type, sizeBytes, createdAt: row.created_at, downloadUrl }
}

// Return a presigned GET URL for a confirmed attachment. This is the first
// implementation of the general "page-view-gated internal-resource resolution"
// pattern: a principal (member OR guest) resolves an internal resource only after
// OpenFGA confirms `view` on the resource's OWN page. The presigned URL is issued
// AFTER that check — never to an unauthorized principal (the P3 image-authz rule,
// extended to the guest principal; guests are not a softer path).
//
// Status rules: pending → 404, deleted → 410 Gone, confirmed → issue presigned GET.
//
// subject = "user:<sub>" | "share_link:<id>"; guests pass a time context so the
// share_link's non_expired condition is evaluated (expired/revoked → denied). No
// explicit resource binding is needed: a share_link grants view on its ONE bound
// page (1 link = 1 resource), so a view check against a DIFFERENT page (the
// attachment's own page) is naturally false — the FGA tuple structure IS the bind.
export async function downloadAttachment(
  db: TenantDb,
  storage: StorageDriver,
  fga: OpenFgaClient,
  args: { id: string; subject: string; context?: { current_time: string } },
): Promise<{ downloadUrl: string; filename: string; expiresAt: string }> {
  const [row] = await db.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${args.id}`
  if (!row || row.status === 'pending') throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (row.status === 'deleted') throw Object.assign(new Error('gone'), { statusCode: 410 })

  const canView = await check(fga, args.subject, 'view', { type: 'page', id: row.page_id }, args.context)
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
  emit({ type: 'attachment.deleted', tenantId: row.tenant_id, attachmentId: row.id, pageId: row.page_id, actorId: args.userId })

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
        plan: req.tenant.plan,
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
    return confirmAttachment(req.db, app.storageDriver, { id: req.params.id, tenantId: req.tenant.id, userId: req.user.sub })
  })

  // Members OR a guest (view share-link). The principal is resolved here; the FGA
  // `view` check on the attachment's page is the authority (guests not softer).
  app.get<{ Params: { id: string } }>('/attachments/:id/download', { config: { guest: 'view' } }, async (req, reply) => {
    const principal = req.user
      ? { subject: `user:${req.user.sub}` }
      : { subject: `share_link:${req.guest!.shareLinkId}`, context: { current_time: new Date().toISOString() } }
    const result = await downloadAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, ...principal })
    return reply.send(result)
  })

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    await deleteAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, userId: req.user.sub })
    return reply.code(204).send()
  })
}
