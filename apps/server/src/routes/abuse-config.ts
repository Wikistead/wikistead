// #491 / ADR-140: the publish-boundary abuse filter CONFIG surface — a tenant-admin UI over the two
// tenant_settings knobs (abuse_shrink_ratio, abuse_banned_words) that until now were DB-direct-only.
// Authz is the existing tenant#admin gate (requireTenantAdmin — OpenFGA is the one truth; no new model,
// no per-member axis). The knobs are moderation POLICY the admin owns for their own tenant, so there is
// no cross-tenant / oracle concern; the banned-word matcher is a token-SET membership test, or for a CJK word
// a plain `indexOf` substring scan (#531, abuse-filter.ts) — never a regex compiled from input, so a word can
// never inject a pattern (and no input-driven backtracking). Read is admin-gated too — the
// banned-word list is moderation intelligence, not shown to ordinary members.
import type { FastifyInstance } from 'fastify'
import { requireTenantAdmin, check } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'
import type { TenantDb } from '../db/index.js'

export interface AbuseFilterConfig {
  shrinkRatio: number | null   // (0,1] enables mass-delete detection; null/anything else = off (matches abuse-filter.ts:38)
  bannedWords: string[]        // normalized: trimmed, non-empty, de-duplicated (case-insensitively), capped
}

// #509 / ADR-187: a space's OWN moderation layer. NULL fields = inherit (no space addition). Distinct
// from the resolved policy — this is only what the SPACE set, never the effective floor⊕space value.
export interface SpaceAbuseFilterConfig {
  shrinkRatio: number | null   // NULL = inherit the tenant floor
  bannedWords: string[] | null // NULL = inherit (no additions); a list = words UNIONed onto the tenant floor
}

const MAX_BANNED_WORDS = 500
const MAX_WORD_LEN = 100

// Clamp to the filter's own enable window: a finite number in (0,1]; anything else = off (null). This
// mirrors the guard the evaluator already applies, so the stored value can never be a "silently ignored"
// out-of-range number that reads as on but never fires.
export function normalizeShrinkRatio(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : null
}

// Trim, drop empties, cap each word's length, de-duplicate case-insensitively (the matcher lowercases),
// and cap the list size — a bounded, sanitized array (never a raw client blob into the moderation path).
export function normalizeBannedWords(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const w = raw.trim().slice(0, MAX_WORD_LEN)
    if (!w) continue
    const key = w.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
    if (out.length >= MAX_BANNED_WORDS) break
  }
  return out
}

export async function getAbuseFilterConfig(db: TenantDb): Promise<AbuseFilterConfig> {
  const [row] = await db.sql<{ abuse_shrink_ratio: number | null; abuse_banned_words: string[] | null }[]>`
    SELECT abuse_shrink_ratio, abuse_banned_words FROM tenant_settings LIMIT 1`
  return { shrinkRatio: row?.abuse_shrink_ratio ?? null, bannedWords: row?.abuse_banned_words ?? [] }
}

// #509 / ADR-187: resolve the EFFECTIVE publish policy = tenant floor ⊕ space layer. ADDITIVE only —
// a space can never weaken the floor:
//   banned words → UNION (a space adds words; it can never remove a tenant-banned word)
//   shrink ratio → STRICTER wins = MAX of the two (a higher ratio rejects MORE publishes). A space's
//                  weaker (lower) ratio can never lower the tenant floor; NULL on either side = off (0).
// Result shrink 0 → null (off), matching the evaluator's disabled state.
export function resolveEffectiveAbusePolicy(tenant: AbuseFilterConfig, space: SpaceAbuseFilterConfig): AbuseFilterConfig {
  const shrink = Math.max(tenant.shrinkRatio ?? 0, space.shrinkRatio ?? 0)
  const banned = new Set<string>()
  for (const w of tenant.bannedWords) banned.add(w)
  for (const w of space.bannedWords ?? []) banned.add(w)
  return { shrinkRatio: shrink > 0 ? shrink : null, bannedWords: [...banned] }
}

// The space's own layer (NULL = inherit). No row / no columns set → fully inherit.
export async function getSpaceAbuseFilterConfig(db: TenantDb, spaceId: string): Promise<SpaceAbuseFilterConfig> {
  const [row] = await db.sql<{ abuse_shrink_ratio: number | null; abuse_banned_words: string[] | null }[]>`
    SELECT abuse_shrink_ratio, abuse_banned_words FROM space_settings WHERE space_id = ${spaceId}`
  return { shrinkRatio: row?.abuse_shrink_ratio ?? null, bannedWords: row?.abuse_banned_words ?? null }
}

// The effective policy a publish in this space is evaluated against (tenant floor ⊕ space layer).
export async function getEffectiveAbusePolicyForSpace(db: TenantDb, spaceId: string): Promise<AbuseFilterConfig> {
  const [tenant, space] = await Promise.all([getAbuseFilterConfig(db), getSpaceAbuseFilterConfig(db, spaceId)])
  return resolveEffectiveAbusePolicy(tenant, space)
}

// Admin-only write. requireTenantAdmin THROWS (403) for a non-admin before any DB write. Values are
// normalized server-side (the fortress) regardless of what the client sent.
export async function updateAbuseFilterConfig(
  db: TenantDb,
  fga: import('@openfga/sdk').OpenFgaClient,
  args: { tenantId: string; userId: string; shrinkRatio: unknown; bannedWords: unknown },
): Promise<AbuseFilterConfig> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const shrinkRatio = normalizeShrinkRatio(args.shrinkRatio)
  const bannedWords = normalizeBannedWords(args.bannedWords)
  // #1126: provisionTenant never creates a tenant_settings row, so a bare UPDATE silently no-ops on a
  // fresh tenant (0 rows affected, unreported) — the save looks like it worked (200, normalized values
  // echoed back) but nothing persisted. Upsert like every other tenant_settings writer in this codebase
  // (branding.ts, api-keys.ts, pages.ts, ai.ts, enroll-domains.ts).
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, abuse_shrink_ratio, abuse_banned_words, updated_at)
    VALUES (${args.tenantId}, ${shrinkRatio}, ${bannedWords}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET abuse_shrink_ratio = ${shrinkRatio}, abuse_banned_words = ${bannedWords}, updated_at = now()
  `
  return { shrinkRatio, bannedWords }
}

// #509 / ADR-187: write the SPACE's own moderation layer. Gated on the space `moderate` capability —
// NOT `manage` (the deliberate exception to "space settings = manage", ruling/): a moderator
// runs the patrol queue, so they own the banned-word/shrink knobs that drive it. `moderate` resolves to
// space#moderator OR manager in the FGA model, so managers keep access and plain members are denied.
// Values are normalized server-side (the fortress); a null clears the layer (back to inherit). Since the
// resolver only ever UNIONs / MAXes with the tenant floor, a space write can never weaken it.
export async function requireSpaceModerate(fga: OpenFgaClient, userId: string, spaceId: string): Promise<void> {
  const canModerate = await check(fga, `user:${userId}`, 'moderate', { type: 'space', id: spaceId })
  if (!canModerate) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

export async function updateSpaceAbuseFilterConfig(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; spaceId: string; userId: string; shrinkRatio: unknown; bannedWords: unknown },
): Promise<SpaceAbuseFilterConfig> {
  await requireSpaceModerate(fga, args.userId, args.spaceId)
  // null passes through as "inherit"; a value is normalized. bannedWords: null = inherit, array = the
  // (sanitized) space additions.
  const shrinkRatio = args.shrinkRatio == null ? null : normalizeShrinkRatio(args.shrinkRatio)
  const bannedWords = args.bannedWords == null ? null : normalizeBannedWords(args.bannedWords)
  // Upsert the space_settings row (it may not exist yet — created lazily like accent_key).
  await db.sql`
    INSERT INTO space_settings (space_id, tenant_id, abuse_shrink_ratio, abuse_banned_words, updated_at)
    VALUES (${args.spaceId}, ${args.tenantId}, ${shrinkRatio}, ${bannedWords}, now())
    ON CONFLICT (space_id) DO UPDATE SET abuse_shrink_ratio = ${shrinkRatio}, abuse_banned_words = ${bannedWords}, updated_at = now()`
  return { shrinkRatio, bannedWords }
}

export async function abuseConfigPlugin(app: FastifyInstance) {
  // Read is admin-gated: the banned-word list is moderation intelligence, not exposed to ordinary members.
  app.get('/tenant/abuse-filter', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id) // throws 403 for non-admins
    return getAbuseFilterConfig(req.db)
  })
  app.patch<{ Body: { shrinkRatio?: unknown; bannedWords?: unknown } }>('/tenant/abuse-filter', async (req) => {
    return updateAbuseFilterConfig(req.db, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub,
      shrinkRatio: req.body?.shrinkRatio ?? null, bannedWords: req.body?.bannedWords ?? [],
    })
  })

  // #509 / ADR-187: the per-space layer. moderate-gated (moderator OR manager). Read returns the space's
  // own layer AND the effective (tenant floor ⊕ space) policy so the UI can show what actually applies.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/abuse-filter', async (req) => {
    await requireSpaceModerate(app.fga, req.user.sub, req.params.spaceId) // throws 403 for a non-moderator
    const [space, tenant, effective] = await Promise.all([
      getSpaceAbuseFilterConfig(req.db, req.params.spaceId),
      getAbuseFilterConfig(req.db),
      getEffectiveAbusePolicyForSpace(req.db, req.params.spaceId),
    ])
    return { space, tenantFloor: tenant, effective }
  })
  app.patch<{ Params: { spaceId: string }; Body: { shrinkRatio?: unknown; bannedWords?: unknown } }>('/spaces/:spaceId/abuse-filter', async (req) => {
    return updateSpaceAbuseFilterConfig(req.db, app.fga, {
      tenantId: req.tenant.id, spaceId: req.params.spaceId, userId: req.user.sub,
      // `undefined` in the body means "not provided" → keep as inherit (null); an explicit value is stored.
      shrinkRatio: 'shrinkRatio' in (req.body ?? {}) ? req.body!.shrinkRatio : null,
      bannedWords: 'bannedWords' in (req.body ?? {}) ? req.body!.bannedWords : null,
    })
  })
}
