import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check } from '@wikistead/authz'
import { assertPageViewable } from '../page-view-gate.js'
import { resolveEntitlements, decideAllowance } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { fanOutFeedEvent } from './notifications.js' // #362 / ADR-126 addendum: attachment.confirmed feed event
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
  inline_kind: InlineKind
}
export interface AttachmentSummary {
  id: string; filename: string; contentType: string
  sizeBytes: number | null; createdAt: Date
}

// #273 / ADR-120: the server-sniffed inline classification. Derived ONLY from the
// object's leading bytes at confirm — the client-declared content_type is untrusted
// (client-set at presign; S3's ContentType is the client's PUT value). Only passive
// kinds may render inline; anything unrecognised is 'none' → download card. HTML /
// SVG / XML deliberately sniff to 'none' (inline active content = stored XSS).
export type InlineKind = 'pdf' | 'image' | 'none'
const SNIFF_BYTES = 512
// Even an allowlisted kind falls back to the download card above this size (review
// condition: never inline-stream an arbitrarily large object through the app).
export const INLINE_MAX_BYTES = 25 * 1024 * 1024

export function sniffInlineKind(bytes: Uint8Array): InlineKind {
  const startsWith = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b)
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf' // %PDF- (strict head match — fail closed)
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image' // PNG
  if (startsWith([0xff, 0xd8, 0xff])) return 'image' // JPEG
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image' // GIF8
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image' // RIFF….WEBP
  return 'none'
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

  // Plan-gated storage quota — the storage consumer of the metered soft-cap substrate (#128 /
  // ADR-082): storage reuses maxStorageBytes as its cap and the SHARED decideAllowance decision (new
  // uploads refused at/over the cap, non-destructive — existing attachments are untouched). Usage =
  // sum of CONFIRMED attachment sizes; pending uploads aren't counted until confirmed (size unknown
  // until then), so concurrent presigns can overshoot slightly — same count+insert race class as
  // maxSpaces; acceptable for v1. Infinity (self-host UNLIMITED) short-circuits the SUM (zero overhead).
  const quota = resolveEntitlements(args.plan).maxStorageBytes
  if (isFinite(quota)) {
    const [{ used }] = await db.sql<[{ used: string }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS used
      FROM attachments WHERE tenant_id = ${args.tenantId} AND status = 'confirmed'
    `
    if (!decideAllowance(Number(used), quota).allowed) {
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
  fga: OpenFgaClient,
  args: { id: string; tenantId: string; userId: string },
): Promise<AttachmentSummary & { downloadUrl: string }> {
  const [row] = await db.sql<AttachmentRow[]>`
    SELECT * FROM attachments WHERE id = ${args.id} AND status = 'pending'
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  // #302(b): confirm was the ONLY write path with no authorization check (it only 404'd a non-pending id).
  // Require the SAME permission as presign — `edit` on the target page — so the whole write surface is
  // uniformly gated. A principal without edit gets a 404 (existence-hidden): a pending id is unguessable, but
  // the write path must not be authz-free. Non-regression: the presigner (who has edit) confirms normally.
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: row.page_id })
  if (!canEdit) throw Object.assign(new Error('not found'), { statusCode: 404 })

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

  // #273 / ADR-120: derive the inline classification from the object's LEADING BYTES —
  // never from the client-declared content_type. A sniff failure fails closed ('none' →
  // download card); it never blocks the confirm (classification is display-only safety).
  let inlineKind: InlineKind = 'none'
  try {
    inlineKind = sniffInlineKind(await storage.getObjectHead(row.s3_key, SNIFF_BYTES))
  } catch { /* unreadable head → 'none' (fail closed) */ }

  // #362 / ADR-126 addendum: emit the feed event IN the same tx as the confirm flip. Confirm is
  // edit-gated but publish-independent — the shared helper's published_at NULL-skip enforces the
  // published-only emission rule (a draft page's attachment activity never becomes a feed row).
  const [pg] = await db.sql<[{ published_at: Date | null; space_id: string }?]>`
    SELECT published_at, space_id FROM pages WHERE id = ${row.page_id}`
  await db.tx(async (tx) => {
    await tx`
      UPDATE attachments
      SET status = 'confirmed', size_bytes = ${sizeBytes}, confirmed_at = now(), inline_kind = ${inlineKind}
      WHERE id = ${args.id}
    `
    await fanOutFeedEvent(tx, { tenantId: args.tenantId, eventType: 'attachment.confirmed', pageId: row.page_id, spaceId: pg?.space_id ?? null, actor: `user:${args.userId}`, publishedAt: pg?.published_at ?? null })
  })
  const downloadUrl = await storage.presignGet(row.s3_key, { ttlSeconds: GET_TTL, disposition: { type: 'attachment', filename: row.filename } })
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
): Promise<{ downloadUrl: string; filename: string; expiresAt: string; sizeBytes: number | null; inlineKind: InlineKind }> {
  const [row] = await db.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${args.id}`
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 }) // no row → 404 (and no page_id to gate on)
  // #297: the view gate runs BEFORE the status checks. Otherwise a soft-DELETED attachment returned 410 Gone
  // to ANYONE who knew its id — a NON-viewer of the page could distinguish a deleted attachment (410) from a
  // confirmed-but-view-denied one (404) = a deletion-state oracle. Gating first makes a non-viewer get a
  // uniform 404 (assertPageViewable is existence-hiding, #280); only a real viewer ever sees pending/410.
  await assertPageViewable(fga, args.subject, row.page_id, args.context) // #108/ADR-071 host-mediated gate
  if (row.status === 'pending') throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (row.status === 'deleted') throw Object.assign(new Error('gone'), { statusCode: 410 })

  // #273 review condition ③ (retroactive): the direct presigned GET is served with
  // `Content-Disposition: attachment` via the signable override — the browser downloads it,
  // never navigates to storage-served bytes. sizeBytes/inlineKind let the client pick the
  // affordance (download card vs inline viewer); inline BYTES go through the proxy route.
  const downloadUrl = await storage.presignGet(row.s3_key, { ttlSeconds: GET_TTL, disposition: { type: 'attachment', filename: row.filename } })
  return {
    downloadUrl, filename: row.filename, expiresAt: new Date(Date.now() + GET_TTL * 1000).toISOString(),
    // size_bytes is BIGINT → the driver returns a string; normalise so clients get a number.
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), inlineKind: row.inline_kind ?? 'none',
  }
}

// #273 / ADR-120: stream an INLINE-viewable attachment through the app so Fastify controls
// the response headers — the authoritative Content-Type comes from the SNIFFED kind (never
// the client-declared type), plus `Content-Disposition: inline`, `X-Content-Type-Options:
// nosniff` and a restrictive CSP. A presigned URL cannot carry nosniff (not a signable
// override), which is exactly why inline bytes are proxied. Same #297 gate order as
// download: view-gate FIRST, then status — a non-viewer gets a uniform 404 always.
// v1 inline kinds: 'pdf' only (images have their own <img> path). A confirmed attachment
// that is not inline-viewable → 415; over the size cap → 413 (client falls back to the card).
const INLINE_CONTENT_TYPE: Record<Exclude<InlineKind, 'none'>, string> = { pdf: 'application/pdf', image: 'application/octet-stream' }
export async function inlineAttachment(
  db: TenantDb,
  storage: StorageDriver,
  fga: OpenFgaClient,
  args: { id: string; subject: string; context?: { current_time: string } },
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const [row] = await db.sql<AttachmentRow[]>`SELECT * FROM attachments WHERE id = ${args.id}`
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  await assertPageViewable(fga, args.subject, row.page_id, args.context)
  if (row.status === 'pending') throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (row.status === 'deleted') throw Object.assign(new Error('gone'), { statusCode: 410 })
  if (row.inline_kind !== 'pdf') throw Object.assign(new Error('not inline-viewable'), { statusCode: 415 })
  if (Number(row.size_bytes ?? 0) > INLINE_MAX_BYTES) throw Object.assign(new Error('too large to view inline'), { statusCode: 413 })
  const bytes = await storage.getObject(row.s3_key)
  return { bytes, contentType: INLINE_CONTENT_TYPE[row.inline_kind], filename: row.filename }
}

// List confirmed attachments for a page. pending and deleted are excluded.
// FGA check: view on page.
export async function listAttachments(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<AttachmentSummary[]> {
  await assertPageViewable(fga, `user:${args.userId}`, args.pageId) // #108/ADR-071 host-mediated gate

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
  // #302(a): the authorization check must PRECEDE any existence-revealing response. Before, `!row || deleted
  // → 204` returned idempotently BEFORE the manage check, so a non-manager member could distinguish a
  // confirmed attachment (403) from a deleted/missing one (204) — a delete-state oracle. Now a caller without
  // manage on the page gets a uniform 404 (existence-hidden) whether the attachment is confirmed, deleted, or
  // missing; only a manager sees the real semantics (idempotent 204 for an already-deleted row, delete for a
  // live one). A missing row has no page to check, so it is a uniform 404 too (indistinguishable from hidden).
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: row.page_id })
  if (!canManage) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (row.status === 'deleted') return  // manager, already deleted → idempotent (204 via the endpoint)

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
    return confirmAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, tenantId: req.tenant.id, userId: req.user.sub })
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

  // #273 / ADR-120: the inline proxy. Members OR guests (view link) — the same principal
  // resolution + FGA view gate as download. The response headers are the XSS boundary:
  // sniffed Content-Type + inline disposition + nosniff + a no-execute CSP.
  app.get<{ Params: { id: string } }>('/attachments/:id/inline', { config: { guest: 'view' } }, async (req, reply) => {
    const principal = req.user
      ? { subject: `user:${req.user.sub}` }
      : { subject: `share_link:${req.guest!.shareLinkId}`, context: { current_time: new Date().toISOString() } }
    const { bytes, contentType, filename } = await inlineAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, ...principal })
    reply.header('Content-Type', contentType)
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; object-src 'none'; script-src 'none'")
    reply.header('Cache-Control', 'private, no-store')
    return reply.send(Buffer.from(bytes))
  })

  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    await deleteAttachment(req.db, app.storageDriver, app.fga, { id: req.params.id, userId: req.user.sub })
    return reply.code(204).send()
  })
}
