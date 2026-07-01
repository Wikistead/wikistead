import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements } from '@wikistead/entitlements'
import { isAccentKey } from '@wikistead/types'
import { emit } from '@wikistead/events'
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'

// Tenant branding (Phase 5d). Asymmetric by design:
//   READ  GET /branding — PUBLIC (tenant resolved from Host; no auth). Visible to
//         members, guests, and unauthenticated visitors of the tenant's pages.
//         Branding is STRIPPED when the plan isn't entitled (a downgrade reverts to
//         the default look; the stored values survive for a re-upgrade).
//   WRITE PATCH /tenant/branding — tenant#admin AND entitlement-gated (403).
// The tenant logo (upload + public byte delivery) is Phase 5d-2 — implemented WITHOUT a multipart
// dependency: the upload is base64-in-JSON (uploadTenantLogo below), MIME-sniffed (png/jpeg/webp only,
// SVG excluded as a stored-XSS vector), size-capped, stored via the S3 abstraction, and served as
// public bytes at GET /branding/logo (host-resolved, entitlement-stripped). #143.
const DISPLAY_NAME_MAX = 64
const LOGO_MAX_BYTES = 512 * 1024
// Cap the raw JSON body BEFORE parse so a huge base64 string can't exhaust memory
// (base64 is ~1.34x the bytes; this bounds a ≤512KB logo with room for JSON overhead).
const LOGO_BODY_LIMIT = 1_000_000

export interface TenantBranding { displayName: string | null; accentKey: string | null; logoUrl: string | null }

// Sniff the real image type from magic bytes — never trust the client content-type.
// SVG is intentionally EXCLUDED: it can carry <script>, and the logo is served as a
// public asset, so an SVG logo would be a stored-XSS vector. png/jpeg/webp only.
function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: 'image/webp', ext: 'webp' }
  return null
}

// Read the public branding for the (RLS-scoped) tenant, stripped when not entitled.
// logoUrl is a stable per-origin path (GET /branding/logo) — never a tenant-id URL.
export async function getTenantBranding(db: TenantDb, plan: string): Promise<TenantBranding> {
  if (!resolveEntitlements(plan).branding) return { displayName: null, accentKey: null, logoUrl: null }
  const [row] = await db.sql<{ accent_key: string | null; display_name: string | null; logo_key: string | null }[]>`
    SELECT accent_key, display_name, logo_key FROM tenant_settings LIMIT 1
  `
  return {
    displayName: row?.display_name ?? null,
    accentKey: row?.accent_key ?? null,
    logoUrl: row?.logo_key ? '/branding/logo' : null,
  }
}

async function requireTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}
function requireBrandingEntitlement(plan: string): void {
  if (!resolveEntitlements(plan).branding) {
    throw Object.assign(new Error('branding requires an upgrade'), { statusCode: 403, code: 'upgrade_required' })
  }
}

// Server-mediated logo upload (Phase 5d-2). base64 in (no multipart dependency):
// the raw JSON body is bounded (route bodyLimit) AND the DECODED size is checked,
// so a giant base64 string can't exhaust memory. Content type is derived from magic
// bytes, the key is server-generated + tenant-scoped (no user filename), and the
// previous object is deleted. admin + entitlement gated.
export async function setTenantLogo(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { tenantId: string; userId: string; plan: string; dataBase64: string },
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  requireBrandingEntitlement(args.plan)
  const bytes = Buffer.from(args.dataBase64 ?? '', 'base64')
  if (bytes.length === 0) throw Object.assign(new Error('empty image'), { statusCode: 400 })
  if (bytes.length > LOGO_MAX_BYTES) throw Object.assign(new Error('image too large'), { statusCode: 413 })
  const kind = sniffImage(bytes)
  if (!kind) throw Object.assign(new Error('unsupported image (png, jpeg, webp only)'), { statusCode: 400 })

  const key = `branding/${args.tenantId}/logo-${randomUUID()}.${kind.ext}`
  await storage.putObject(key, bytes, kind.mime)
  const [old] = await db.sql<{ logo_key: string | null }[]>`SELECT logo_key FROM tenant_settings WHERE tenant_id = ${args.tenantId}`
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, logo_key, logo_content_type, updated_at)
    VALUES (${args.tenantId}, ${key}, ${kind.mime}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET logo_key = ${key}, logo_content_type = ${kind.mime}, updated_at = now()
  `
  if (old?.logo_key && old.logo_key !== key) await storage.deleteObject(old.logo_key).catch(() => {})
  emit({ type: 'tenant.branding_updated', tenantId: args.tenantId, actorId: args.userId })
}

export async function clearTenantLogo(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { tenantId: string; userId: string },
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const [old] = await db.sql<{ logo_key: string | null }[]>`SELECT logo_key FROM tenant_settings WHERE tenant_id = ${args.tenantId}`
  await db.sql`UPDATE tenant_settings SET logo_key = NULL, logo_content_type = NULL, updated_at = now() WHERE tenant_id = ${args.tenantId}`
  if (old?.logo_key) await storage.deleteObject(old.logo_key).catch(() => {})
  emit({ type: 'tenant.branding_updated', tenantId: args.tenantId, actorId: args.userId })
}

// Set the tenant branding. tenant#admin AND entitlement gated (mirrors members.ts).
export async function updateTenantBranding(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; plan: string; accentKey: string | null; displayName: string | null },
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  requireBrandingEntitlement(args.plan)
  if (args.accentKey !== null && !isAccentKey(args.accentKey)) {
    throw Object.assign(new Error('unknown accent'), { statusCode: 400 })
  }
  const raw = (args.displayName ?? '').trim()
  const displayName = raw === '' ? null : raw.slice(0, DISPLAY_NAME_MAX)
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, accent_key, display_name, updated_at)
    VALUES (${args.tenantId}, ${args.accentKey}, ${displayName}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET accent_key = ${args.accentKey}, display_name = ${displayName}, updated_at = now()
  `
  emit({ type: 'tenant.branding_updated', tenantId: args.tenantId, actorId: args.userId })
}

export async function brandingPlugin(app: FastifyInstance) {
  // PUBLIC read — the only auth is tenant resolution from the Host (see app.ts).
  app.get('/branding', { config: { public: true } }, async (req) => getTenantBranding(req.db, req.tenant.plan))

  // PUBLIC logo bytes. Host-resolved (no tenant id in the URL → no enumeration);
  // entitlement-stripped (404 when off). Intentionally UNAUTHENTICATED: the logo is
  // a public asset, so this is a deliberate public consumer of getObject (unlike
  // page attachments, where the caller must FGA-check view first). 404 when absent.
  app.get('/branding/logo', { config: { public: true } }, async (req, reply) => {
    if (!resolveEntitlements(req.tenant.plan).branding) return reply.code(404).send()
    const [row] = await req.db.sql<{ logo_key: string | null; logo_content_type: string | null }[]>`
      SELECT logo_key, logo_content_type FROM tenant_settings LIMIT 1
    `
    if (!row?.logo_key) return reply.code(404).send()
    const bytes = await app.storageDriver.getObject(row.logo_key)
    return reply
      .header('Content-Type', row.logo_content_type ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=300')
      .send(Buffer.from(bytes))
  })

  app.patch<{ Body: { accentKey?: string | null; displayName?: string | null } }>('/tenant/branding', async (req, reply) => {
    await updateTenantBranding(req.db, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
      accentKey: req.body?.accentKey ?? null, displayName: req.body?.displayName ?? null,
    })
    return reply.code(204).send()
  })

  // Server-mediated base64 upload; bodyLimit bounds the raw body before parse.
  app.post<{ Body: { data?: string } }>('/tenant/branding/logo', { bodyLimit: LOGO_BODY_LIMIT }, async (req, reply) => {
    await setTenantLogo(req.db, app.fga, app.storageDriver, {
      tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan, dataBase64: req.body?.data ?? '',
    })
    return reply.code(204).send()
  })

  app.delete('/tenant/branding/logo', async (req, reply) => {
    await clearTenantLogo(req.db, app.fga, app.storageDriver, { tenantId: req.tenant.id, userId: req.user.sub })
    return reply.code(204).send()
  })
}
