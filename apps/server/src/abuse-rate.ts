// #328 / ADR-140 increment 2: guest publish rate caps. Fixed-window buckets (ADR-063 bumpRateBucket)
// keyed on the share-link id AND the #331 pseudonymous session id — NEVER raw IP (ADR-140 I1 / ADR-138;
// the pre-auth token-exchange IP buckets in share-links.ts are a different, out-of-scope surface). The
// per-LINK bucket bounds the whole link; the per-SESSION bucket bounds one guest within it, so a single
// abuser exhausts their own budget without consuming a good-faith co-editor's (set the session max below
// the link max for that isolation to bite). Members are never rate-capped here (moderation for members is
// an identity/role concern, not this filter). Defaults are NULL = unlimited: the caps read is one cheap
// SELECT and the Infinity short-circuit does no Valkey I/O, so a self-host tenant pays ~nothing.
import type IORedis from 'ioredis'
import type { TenantDb } from './db/index.js'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from './rate-limit.js'

export interface GuestRateIdentity {
  tenantId: string
  shareLinkId: string
  // Absent on a token minted before #331 — the per-session bucket is skipped then (the link bucket
  // still bounds the link as a whole).
  anonId?: string
}

// A max that is unset (NULL) or nonsensical (≤0 — a 0 cap would block EVERY publish; there is no config
// UI in this increment, so clamp bad values to off like increment 1's shrink-ratio guard) means unlimited.
export function normalizeRateMax(max: number | null | undefined): number {
  return max != null && max > 0 ? max : Infinity
}

// True = within budget. Bumps the link bucket and (when the token carries a session id) the session
// bucket; counting an over-budget attempt is intentional (a rejected try still consumes window budget).
export async function guestPublishRateAllowed(valkey: IORedis, db: TenantDb, id: GuestRateIdentity): Promise<boolean> {
  const [caps] = await db.sql<[{ abuse_publish_rate_link_max: number | null; abuse_publish_rate_session_max: number | null }?]>`
    SELECT abuse_publish_rate_link_max, abuse_publish_rate_session_max FROM tenant_settings WHERE tenant_id = ${id.tenantId}
  `
  const linkMax = normalizeRateMax(caps?.abuse_publish_rate_link_max)
  const sessionMax = normalizeRateMax(caps?.abuse_publish_rate_session_max)
  const okLink = await bumpRateBucket(valkey, `rl:abuse:pub:link:${id.tenantId}:${id.shareLinkId}`, linkMax, API_RATE_LIMIT_WINDOW_S)
  const okSession = id.anonId
    ? await bumpRateBucket(valkey, `rl:abuse:pub:anon:${id.tenantId}:${id.anonId}`, sessionMax, API_RATE_LIMIT_WINDOW_S)
    : true
  return okLink && okSession
}
