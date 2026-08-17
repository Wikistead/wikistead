import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'
import { isSpaceCreator } from '@wikistead/authz' // #445the caller's own space-creation capability
// Account settings option sets live in the pure settings-catalog leaf (#139 doc↔code linkage):
// the SINGLE source for both this route's validation and the generated settings reference.
import { KEYMAP_MODES, DISPLAY_MODE_PREFS, VIM_CLIPBOARD_MODES, REMAPPABLE_COMMANDS, RESERVED_KEYS, validateEditorChrome, type KeymapMode, type DisplayModePref, type VimClipboardMode, type EditorChromeVisibility } from '../settings-catalog.js'
export type { KeymapMode, DisplayModePref, EditorChromeVisibility }

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

// Server-side guard for a keybindings map (the UI validates too — this is the bastion):
// only known command ids, non-empty values, no browser-reserved keys, no duplicates.
function validateKeybindings(kb: Record<string, string>): void {
  const seen = new Set<string>()
  for (const [cmd, key] of Object.entries(kb)) {
    if (!REMAPPABLE_COMMANDS.includes(cmd)) throw Object.assign(new Error(`unknown command: ${cmd}`), { statusCode: 400 })
    const norm = typeof key === 'string' ? key.trim() : ''
    if (!norm) throw Object.assign(new Error(`empty key for ${cmd}`), { statusCode: 400 })
    if (RESERVED_KEYS.includes(norm)) throw Object.assign(new Error(`reserved key: ${norm}`), { statusCode: 400 })
    if (seen.has(norm)) throw Object.assign(new Error(`duplicate key: ${norm}`), { statusCode: 400 })
    seen.add(norm)
  }
}

export interface AccountSettings {
  displayName: string | null          // effective: override ?? OIDC ?? null
  oidcDisplayName: string | null      // the IdP value (for the "reset to IdP name" label)
  displayNameOverride: string | null  // the user's override (null = using OIDC)
  // #523 / ADR-190: where this identity came from. 'oidc' → the name is IdP-managed and the override
  // is refused (the UI shows it read-only); 'local' → the user may edit it. (slice C)
  identitySource: string
  editorKeymap: KeymapMode            // startup-mode preference (keymap)
  editorDisplayMode: DisplayModePref  // startup display mode (ADR-056 / #164)
  editorVimClipboard: VimClipboardMode // vim ⇄ OS clipboard mode (ADR-105 / #225); 'off' = pure vim
  keybindings: Record<string, string> // commandId → chord override (ADR-021); {} = defaults
  hasAvatar: boolean                  // an uploaded avatar exists (else OIDC/initials)
  // #289 / ADR-115: chrome visibility (null = never enrolled → all shown) + the first-run gate
  // (null = the two-question flow has not been seen → the client fires it once).
  editorChrome: EditorChromeVisibility | null
  onboardingCompletedAt: string | null
  // #362 / ADR-126 addendum: member notification defaults (emission-narrowing only — the feed/inbox
  // display gates are the sole permission authority). notificationsEnabled=false = global kill switch;
  // defaultEventMask applies to watches whose own mask is empty ([] = all types).
  notificationsEnabled: boolean
  defaultEventMask: string[]
  // #547 / ADR-196 §3: email delivery prefs (both UNDER the kill switch above — enforced at fan-out).
  // immediate defaults ON (mention mail; a narrowing of the pre-196 behavior), digest OFF (opt-in).
  emailImmediate: boolean
  emailDigest: boolean
}

export async function getAccountSettings(db: TenantDb, args: { subject: string }): Promise<AccountSettings> {
  const [m] = await db.sql<[{ display_name: string | null; display_name_override: string | null; avatar_image_key: string | null; editor_keymap: string | null; editor_display_mode: string | null; editor_vim_clipboard: string | null; keybindings: unknown; editor_chrome: unknown; onboarding_completed_at: Date | string | null; notifications_enabled: boolean | null; default_event_mask: string[] | null; email_immediate: boolean | null; email_digest: boolean | null; identity_source: string }?]>`
    SELECT display_name, display_name_override, avatar_image_key, editor_keymap, editor_display_mode, editor_vim_clipboard, keybindings, editor_chrome, onboarding_completed_at, notifications_enabled, default_event_mask, email_immediate, email_digest, identity_source
    FROM members WHERE sub = ${args.subject} LIMIT 1`
  if (!m) throw Object.assign(new Error('no member row'), { statusCode: 404 })
  // JSONB comes back as a raw JSON string from this pg driver — parse it (null → {}).
  const kb = m.keybindings == null ? {} : typeof m.keybindings === 'string' ? JSON.parse(m.keybindings) : m.keybindings
  const chromeRaw = m.editor_chrome == null ? null : typeof m.editor_chrome === 'string' ? JSON.parse(m.editor_chrome) : m.editor_chrome
  return {
    displayName: m.display_name_override ?? m.display_name ?? null,
    oidcDisplayName: m.display_name ?? null,
    displayNameOverride: m.display_name_override ?? null,
    identitySource: m.identity_source ?? 'oidc',
    editorKeymap: (KEYMAP_MODES as string[]).includes(m.editor_keymap ?? '') ? (m.editor_keymap as KeymapMode) : 'local',
    editorDisplayMode: (DISPLAY_MODE_PREFS as string[]).includes(m.editor_display_mode ?? '') ? (m.editor_display_mode as DisplayModePref) : 'local',
    editorVimClipboard: (VIM_CLIPBOARD_MODES as string[]).includes(m.editor_vim_clipboard ?? '') ? (m.editor_vim_clipboard as VimClipboardMode) : 'off',
    keybindings: kb as Record<string, string>,
    hasAvatar: !!m.avatar_image_key,
    editorChrome: chromeRaw as EditorChromeVisibility | null,
    onboardingCompletedAt: m.onboarding_completed_at == null ? null : new Date(m.onboarding_completed_at).toISOString(),
    notificationsEnabled: m.notifications_enabled ?? true,
    defaultEventMask: m.default_event_mask ?? [],
    emailImmediate: m.email_immediate ?? true,
    emailDigest: m.email_digest ?? false,
  }
}

// ADR-180 — the personal activity heatmap. A per-day count of the caller's OWN authored
// content (revisions + comments) over the last ~12 months, for the contribution calendar on
// the account page. SELF-SCOPE, enforced TWICE: the subject is the session sub (never a
// parameter — the endpoint has no "whose activity" input), AND the query filters on it
// (`created_by = 'user:'||sub` / `author_sub = sub`) on top of the tenant RLS handle. There is
// no code path to read another member's heatmap. No new table — the counts come from the
// existing revisions/comments tables (CE, self-only, #464-independent).
// day = 'YYYY-MM-DD' in the caller's tz. #483the count is split by kind (edits = revisions,
// comments) so the hover tooltip can show a breakdown; count stays their sum for existing consumers.
export interface ActivityDay { day: string; count: number; edits: number; comments: number }

// Validate an IANA time-zone name (the client passes its browser tz). An unknown zone would
// make `AT TIME ZONE` throw at the DB, so fall back to UTC. It is a BOUND parameter either way
// (no SQL injection surface) — this only guards against a runtime error from a bogus value.
function safeTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return 'UTC' }
}

export async function getMyActivity(db: TenantDb, args: { subject: string; tz?: string }): Promise<{ tz: string; days: ActivityDay[] }> {
  const tz = safeTimeZone(args.tz)
  // Bucket by CALENDAR DAY in the member's tz: a heatmap day is a calendar day to the person
  // looking at it. `created_at` stays UTC in storage; only the bucket expression is tz-shifted.
  // A soft-deleted comment (deleted_at) is excluded — retracted work is not a contribution.
  // #483the UNION ALL carries its kind through, so one pass yields the per-kind split the
  // tooltip breakdown needs. The predicates — and so the SELF-SCOPE — are byte-identical to before.
  const rows = await db.sql<{ day: string; count: number; edits: number; comments: number }[]>`
    SELECT day, count(*)::int AS count,
           (count(*) FILTER (WHERE kind = 'edit'))::int AS edits,
           (count(*) FILTER (WHERE kind = 'comment'))::int AS comments
    FROM (
      SELECT to_char((created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, kind
      FROM (
        SELECT created_at, 'edit' AS kind FROM revisions WHERE created_by = ${'user:' + args.subject}
        UNION ALL
        SELECT created_at, 'comment' AS kind FROM comments WHERE author_sub = ${args.subject} AND deleted_at IS NULL
      ) events
      WHERE created_at >= now() - interval '12 months'
    ) bucketed
    GROUP BY day
    ORDER BY day`
  return { tz, days: rows.map((r) => ({ day: r.day, count: Number(r.count), edits: Number(r.edits), comments: Number(r.comments) })) }
}

// Update the caller's own profile prefs. Only the provided fields change. An empty/blank
// displayNameOverride clears it (→ fall back to the OIDC name). The login upsert writes
// only display_name, so the override set here survives re-login (ADR-020 D2).
export async function updateAccountSettings(
  db: TenantDb,
  args: { subject: string; displayNameOverride?: string | null; editorKeymap?: string; editorDisplayMode?: string; editorVimClipboard?: string; keybindings?: Record<string, string>; editorChrome?: unknown; onboardingCompleted?: boolean; notificationsEnabled?: boolean; defaultEventMask?: string[]; emailImmediate?: boolean; emailDigest?: boolean },
): Promise<AccountSettings> {
  if (args.editorKeymap !== undefined && !(KEYMAP_MODES as string[]).includes(args.editorKeymap)) {
    throw Object.assign(new Error('invalid keymap'), { statusCode: 400 })
  }
  if (args.editorDisplayMode !== undefined && !(DISPLAY_MODE_PREFS as string[]).includes(args.editorDisplayMode)) {
    throw Object.assign(new Error('invalid display mode'), { statusCode: 400 })
  }
  if (args.editorVimClipboard !== undefined && !(VIM_CLIPBOARD_MODES as string[]).includes(args.editorVimClipboard)) {
    throw Object.assign(new Error('invalid vim clipboard mode'), { statusCode: 400 })
  }
  if (args.keybindings !== undefined) validateKeybindings(args.keybindings)
  // #289: chrome visibility — strict shape (or explicit null = reset to defaults/all-shown).
  const chrome = args.editorChrome === undefined ? undefined : args.editorChrome === null ? null : validateEditorChrome(args.editorChrome)
  // #289: the onboarding marker is one-way (a client can mark seen, never un-see — re-running the
  // questions goes through the settings redo entry, which does not need the flag cleared).
  if (args.onboardingCompleted !== undefined && args.onboardingCompleted !== true) {
    throw Object.assign(new Error('invalid onboardingCompleted'), { statusCode: 400 })
  }
  if (args.displayNameOverride !== undefined) {
    // #523 / ADR-190 §2: an OIDC-sourced member's display name is the IdP name (authoritative,
    // anti-impersonation) — they may NOT override it. The account UI hides the field for them (slice C);
    // the server is the fortress, so a direct write is refused (403). A 'local' user may still set one.
    // ALLOWLIST (fail-safe): only a 'local' user may override — any other source (today 'oidc', and any
    // future IdP value like 'saml') is refused, so a new provider can never fail OPEN into an override.
    const [src] = await db.sql<[{ identity_source: string }?]>`SELECT identity_source FROM members WHERE sub = ${args.subject}`
    if (src?.identity_source !== 'local') {
      throw Object.assign(new Error('your display name is managed by your identity provider'), { statusCode: 403 })
    }
    const v = args.displayNameOverride?.trim() ? args.displayNameOverride.trim() : null
    await db.sql`UPDATE members SET display_name_override = ${v}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.editorKeymap !== undefined) {
    await db.sql`UPDATE members SET editor_keymap = ${args.editorKeymap}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.editorDisplayMode !== undefined) {
    await db.sql`UPDATE members SET editor_display_mode = ${args.editorDisplayMode}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.editorVimClipboard !== undefined) {
    await db.sql`UPDATE members SET editor_vim_clipboard = ${args.editorVimClipboard}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.keybindings !== undefined) {
    await db.sql`UPDATE members SET keybindings = ${JSON.stringify(args.keybindings)}::jsonb, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (chrome !== undefined) {
    await db.sql`UPDATE members SET editor_chrome = ${chrome === null ? null : JSON.stringify(chrome)}::jsonb, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.onboardingCompleted === true) {
    await db.sql`UPDATE members SET onboarding_completed_at = COALESCE(onboarding_completed_at, now()), updated_at = now() WHERE sub = ${args.subject}`
  }
  // #362: notification defaults (self-scope like everything here; emission-narrowing only).
  // #547 S6: the email prefs — same self-scope discipline (the subject is the session sub, never a
  // parameter), boolean-validated, RLS handle.
  if (args.emailImmediate !== undefined) {
    if (typeof args.emailImmediate !== 'boolean') throw Object.assign(new Error('invalid emailImmediate'), { statusCode: 400 })
    await db.sql`UPDATE members SET email_immediate = ${args.emailImmediate}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.emailDigest !== undefined) {
    if (typeof args.emailDigest !== 'boolean') throw Object.assign(new Error('invalid emailDigest'), { statusCode: 400 })
    await db.sql`UPDATE members SET email_digest = ${args.emailDigest}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.notificationsEnabled !== undefined) {
    if (typeof args.notificationsEnabled !== 'boolean') throw Object.assign(new Error('invalid notificationsEnabled'), { statusCode: 400 })
    await db.sql`UPDATE members SET notifications_enabled = ${args.notificationsEnabled}, updated_at = now() WHERE sub = ${args.subject}`
  }
  if (args.defaultEventMask !== undefined) {
    if (!Array.isArray(args.defaultEventMask)) throw Object.assign(new Error('invalid defaultEventMask'), { statusCode: 400 })
    const mask = args.defaultEventMask.map(String).slice(0, 32)
    await db.sql`UPDATE members SET default_event_mask = ${mask}::text[], updated_at = now() WHERE sub = ${args.subject}`
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

// #445the caller's OWN capabilities, so the UI can hide an affordance it knows will be
// refused. Self-scoped (the route passes req.user.sub — no other principal is addressable) and it
// discloses nothing about the tenant beyond what pressing the button would already reveal.
// Convenience only: the server stays the fortress, and a stale flag still gets the 403 and its
// message (two-layer rule). Extracted from the handler so the refused case is directly testable —
// the dev bearer only ever resolves to a tenant admin, which always passes.
export interface MyCapabilities { canCreateSpaces: boolean }
export async function resolveCapabilities(
  fga: Parameters<typeof isSpaceCreator>[0],
  args: { subject: string; tenantId: string },
): Promise<MyCapabilities> {
  return { canCreateSpaces: await isSpaceCreator(fga, args.subject, args.tenantId) }
}

export async function accountPlugin(app: FastifyInstance) {
  // All member-gated (the default guard requires req.user; guests/unauth are rejected).
  app.get('/me/settings', async (req) => getAccountSettings(req.db, { subject: req.user.sub }))

  app.get('/me/capabilities', async (req) => resolveCapabilities(app.fga, { subject: req.user.sub, tenantId: req.tenant.id }))

  // ADR-180: the caller's OWN daily activity for the contribution heatmap. Self-scoped — the
  // subject is the session sub (req.user.sub), never a parameter; `tz` only chooses the day-bucket
  // boundary. An empty history returns an empty `days` array (not an error).
  app.get<{ Querystring: { tz?: string } }>('/me/activity', async (req) => getMyActivity(req.db, { subject: req.user.sub, tz: req.query?.tz }))

  app.patch<{ Body: { displayNameOverride?: string | null; editorKeymap?: string; editorDisplayMode?: string; editorVimClipboard?: string; keybindings?: Record<string, string>; editorChrome?: unknown; onboardingCompleted?: boolean; notificationsEnabled?: boolean; defaultEventMask?: string[]; emailImmediate?: boolean; emailDigest?: boolean } }>('/me/settings', async (req) =>
    // #583: emailImmediate/emailDigest were DECLARED in the body type and then not forwarded, so the
    // two toggles on /settings/account returned 204 and changed nothing. Both fields are optional, so
    // nothing in the type system noticed; the tests all called updateAccountSettings directly, so
    // nothing in the suite noticed either. account-settings-wiring-583.test.ts now compares the
    // declared keys against the forwarded ones, which catches the next field to be added and dropped.
    updateAccountSettings(req.db, { subject: req.user.sub, displayNameOverride: req.body?.displayNameOverride, editorKeymap: req.body?.editorKeymap, editorDisplayMode: req.body?.editorDisplayMode, editorVimClipboard: req.body?.editorVimClipboard, keybindings: req.body?.keybindings, editorChrome: req.body?.editorChrome, onboardingCompleted: req.body?.onboardingCompleted, notificationsEnabled: req.body?.notificationsEnabled, defaultEventMask: req.body?.defaultEventMask, emailImmediate: req.body?.emailImmediate, emailDigest: req.body?.emailDigest }),
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
