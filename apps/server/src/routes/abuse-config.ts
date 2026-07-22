// #491 / ADR-140: the publish-boundary abuse filter CONFIG surface — a tenant-admin UI over the two
// tenant_settings knobs (abuse_shrink_ratio, abuse_banned_words) that until now were DB-direct-only.
// Authz is the existing tenant#admin gate (requireTenantAdmin — OpenFGA is the one truth; no new model,
// no per-member axis). The knobs are moderation POLICY the admin owns for their own tenant, so there is
// no cross-tenant / oracle concern; the banned-word matcher is a token-SET membership test (abuse-filter.ts),
// never a regex compiled from input, so a word can never inject a pattern. Read is admin-gated too — the
// banned-word list is moderation intelligence, not shown to ordinary members.
import type { FastifyInstance } from 'fastify'
import { requireTenantAdmin } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'

export interface AbuseFilterConfig {
  shrinkRatio: number | null   // (0,1] enables mass-delete detection; null/anything else = off (matches abuse-filter.ts:38)
  bannedWords: string[]        // normalized: trimmed, non-empty, de-duplicated (case-insensitively), capped
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
  await db.sql`UPDATE tenant_settings SET abuse_shrink_ratio = ${shrinkRatio}, abuse_banned_words = ${bannedWords}, updated_at = now() WHERE tenant_id = ${args.tenantId}`
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
}
