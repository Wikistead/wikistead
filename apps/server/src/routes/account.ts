import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'

// ADR-020 — personal account settings. SELF-SCOPE: every read/write is keyed to the
// authenticated member's own row (WHERE sub = req.user.sub) + tenant RLS. This is
// identity ("I am me"), NOT an OpenFGA resource ACL — there is no shared object — so no
// FGA check is involved. Guests (share-link) have no member row and never reach here.

const AVATAR_MAX_BYTES = 512 * 1024
// Bound the raw JSON body BEFORE parse so a huge base64 string can't exhaust memory
// (base64 ≈ 1.34x the bytes; this fits a ≤512KB image with JSON overhead).
const AVATAR_BODY_LIMIT = 1_000_000
// Content type from MAGIC BYTES, never the client header. SVG excluded — the avatar is a
// PUBLIC asset, so an SVG could carry <script> = stored XSS (mirrors the space icon).
function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: 'image/webp', ext: 'webp' }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: 'image/gif', ext: 'gif' }
  return null
}

// editorKeymap is the STARTUP-MODE preference (cross-device): how the editor opens.
//   'vim'     — always start in vim (the toolbar toggle still switches for the session)
//   'default' — always start in non-vim
//   'local'   — follow this device's last toolbar choice (localStorage). Default.
export type KeymapMode = 'default' | 'vim' | 'local'
const KEYMAP_MODES: KeymapMode[] = ['default', 'vim', 'local']
export interface AccountSettings {
  displayName: string | null          // effective: override ?? OIDC ?? null
  oidcDisplayName: string | null      // the IdP value (for the "reset to IdP name" label)
  displayNameOverride: string | null  // the user's override (null = using OIDC)
  editorKeymap: KeymapMode            // startup-mode preference
  hasAvatar: boolean                  // an uploaded avatar exists (else OIDC/initials)
}

export async function getAccountSettings(db: TenantDb, args: { subject: string }): Promise<AccountSettings> {
  const [m] = await db.sql<[{ display_name: string | null; display_name_override: string | null; avatar_image_key: string | null; editor_keymap: string | null }?]>`
    SELECT display_name, display_name_override, avatar_image_key, editor_keymap
    FROM members WHERE sub = ${args.subject} LIMIT 1`
  if (!m) throw Object.assign(new Error('no member row'), { statusCode: 404 })
  return {
    displayName: m.display_name_override ?? m.display_name ?? null,
    oidcDisplayName: m.display_name ?? null,
    displayNameOverride: m.display_name_override ?? null,
    editorKeymap: (KEYMAP_MODES as string[]).includes(m.editor_keymap ?? '') ? (m.editor_keymap as KeymapMode) : 'local',
    hasAvatar: !!m.avatar_image_key,
  }
}

// Update the caller's own profile prefs. Only the provided fields change. An empty/blank
// displayNameOverride clears it (→ fall back to the OIDC name). The login upsert writes
// only display_name, so the override set here survives re-login (ADR-020 D2).
export async function updateAccountSettings(
  db: TenantDb,
  args: { subject: string; displayNameOverride?: string | null; editorKeymap?: string },
): Promise<AccountSettings> {
  if (args.editorKeymap !== undefined && !(KEYMAP_MODES as string[]).includes(args.editorKeymap)) {
    throw Object.assign(new Error('invalid keymap'), { statusCode: 400 })
  }
  if (args.displayNameOverride !== undefined) {
    const v = args.displayNameOverride?.trim() ? args.displayNameOverride.trim() : null
    await db.sql`UPDATE members SET display_name_override = ${v}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.editorKeymap !== undefined) {
    await db.sql`UPDATE members SET editor_keymap = ${args.editorKeymap}, updated_at = now() WHERE sub = ${args.subject}`
  }
  return getAccountSettings(db, { subject: args.subject })
}

// Upload the caller's avatar (mirrors setSpaceIconImage). base64 in, magic-byte sniff,
// SVG excluded, size-capped, bytes to storage under a server key, key in the DB.
export async function setAvatar(
  db: TenantDb,
  storage: StorageDriver,
  args: { subject: string; dataBase64: string },
): Promise<void> {
  const bytes = Buffer.from(args.dataBase64 ?? '', 'base64')
  if (bytes.length === 0) throw Object.assign(new Error('empty image'), { statusCode: 400 })
  if (bytes.length > AVATAR_MAX_BYTES) throw Object.assign(new Error('image too large'), { statusCode: 413 })
  const kind = sniffImage(bytes)
  if (!kind) throw Object.assign(new Error('unsupported image (png, jpeg, webp, gif only)'), { statusCode: 400 })

  const key = `avatars/${randomUUID()}.${kind.ext}`
  await storage.putObject(key, bytes, kind.mime)
  const [old] = await db.sql<[{ avatar_image_key: string | null }?]>`SELECT avatar_image_key FROM members WHERE sub = ${args.subject}`
  if (!old) { await storage.deleteObject(key).catch(() => {}); throw Object.assign(new Error('no member row'), { statusCode: 404 }) }
  await db.sql`UPDATE members SET avatar_image_key = ${key}, avatar_image_content_type = ${kind.mime}, updated_at = now() WHERE sub = ${args.subject}`
  if (old.avatar_image_key && old.avatar_image_key !== key) await storage.deleteObject(old.avatar_image_key).catch(() => {})
}

export async function clearAvatar(db: TenantDb, storage: StorageDriver, args: { subject: string }): Promise<void> {
  const [old] = await db.sql<[{ avatar_image_key: string | null }?]>`SELECT avatar_image_key FROM members WHERE sub = ${args.subject}`
  await db.sql`UPDATE members SET avatar_image_key = NULL, avatar_image_content_type = NULL, updated_at = now() WHERE sub = ${args.subject}`
  if (old?.avatar_image_key) await storage.deleteObject(old.avatar_image_key).catch(() => {})
}

export async function accountPlugin(app: FastifyInstance) {
  // All member-gated (the default guard requires req.user; guests/unauth are rejected).
  app.get('/me/settings', async (req) => getAccountSettings(req.db, { subject: req.user.sub }))

  app.patch<{ Body: { displayNameOverride?: string | null; editorKeymap?: string } }>('/me/settings', async (req) =>
    updateAccountSettings(req.db, { subject: req.user.sub, displayNameOverride: req.body?.displayNameOverride, editorKeymap: req.body?.editorKeymap }),
  )

  app.put<{ Body: { data?: string } }>('/me/avatar', { bodyLimit: AVATAR_BODY_LIMIT }, async (req, reply) => {
    await setAvatar(req.db, app.storageDriver, { subject: req.user.sub, dataBase64: req.body?.data ?? '' })
    return reply.code(204).send()
  })

  app.delete('/me/avatar', async (req, reply) => {
    await clearAvatar(req.db, app.storageDriver, { subject: req.user.sub })
    return reply.code(204).send()
  })

  // PUBLIC avatar bytes (peer-visible identity, like the OIDC picture). RLS scopes the
  // query to the Host-resolved tenant, so a sub from another tenant yields no row (404)
  // — no cross-tenant read. Served unauthed so <img> tags (no bearer) can render it.
  app.get<{ Params: { sub: string } }>('/members/:sub/avatar-image', { config: { public: true } }, async (req, reply) => {
    const [row] = await req.db.sql<[{ avatar_image_key: string | null; avatar_image_content_type: string | null }?]>`
      SELECT avatar_image_key, avatar_image_content_type FROM members WHERE sub = ${req.params.sub} LIMIT 1`
    if (!row?.avatar_image_key) return reply.code(404).send()
    const bytes = await app.storageDriver.getObject(row.avatar_image_key)
    return reply
      .header('Content-Type', row.avatar_image_content_type ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=300')
      .send(Buffer.from(bytes))
  })
}
