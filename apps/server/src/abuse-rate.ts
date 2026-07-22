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
async function twoBucketAllowed(
  valkey: IORedis,
  id: GuestRateIdentity,
  surface: string,
  linkMaxRaw: number | null | undefined,
  sessionMaxRaw: number | null | undefined,
): Promise<boolean> {
  const linkMax = normalizeRateMax(linkMaxRaw)
  const sessionMax = normalizeRateMax(sessionMaxRaw)
  const okLink = await bumpRateBucket(valkey, `rl:abuse:${surface}:link:${id.tenantId}:${id.shareLinkId}`, linkMax, API_RATE_LIMIT_WINDOW_S)
  const okSession = id.anonId
    ? await bumpRateBucket(valkey, `rl:abuse:${surface}:anon:${id.tenantId}:${id.anonId}`, sessionMax, API_RATE_LIMIT_WINDOW_S)
    : true
  return okLink && okSession
}

export async function guestPublishRateAllowed(valkey: IORedis, db: TenantDb, id: GuestRateIdentity): Promise<boolean> {
  const [caps] = await db.sql<[{ abuse_publish_rate_link_max: number | null; abuse_publish_rate_session_max: number | null }?]>`
    SELECT abuse_publish_rate_link_max, abuse_publish_rate_session_max FROM tenant_settings WHERE tenant_id = ${id.tenantId}
  `
  return twoBucketAllowed(valkey, id, 'pub', caps?.abuse_publish_rate_link_max, caps?.abuse_publish_rate_session_max)
}

// #274 / ADR-135 §3: the guest CREATED-PAGE cap, enforced at the atomic create-publish endpoint. Same
// two-bucket window shape as publish (business ruling 2 keys it by link AND session; migration 068).
export async function guestCreatePageRateAllowed(valkey: IORedis, db: TenantDb, id: GuestRateIdentity): Promise<boolean> {
  const [caps] = await db.sql<[{ abuse_create_page_link_max: number | null; abuse_create_page_session_max: number | null }?]>`
    SELECT abuse_create_page_link_max, abuse_create_page_session_max FROM tenant_settings WHERE tenant_id = ${id.tenantId}
  `
  return twoBucketAllowed(valkey, id, 'create', caps?.abuse_create_page_link_max, caps?.abuse_create_page_session_max)
}

// #274 / ADR-135 §4: guest attachment count cap — a FIXED-WINDOW rate like every cap here (resets each
// API_RATE_LIMIT_WINDOW_S), NOT a lifetime total. Bumped at presign — the request that reserves an upload
// slot; an abandoned presign still consumed window budget, which is the conservative direction.
export async function guestAttachRateAllowed(valkey: IORedis, db: TenantDb, id: GuestRateIdentity): Promise<boolean> {
  const [caps] = await db.sql<[{ abuse_attach_count_link_max: number | null; abuse_attach_count_session_max: number | null }?]>`
    SELECT abuse_attach_count_link_max, abuse_attach_count_session_max FROM tenant_settings WHERE tenant_id = ${id.tenantId}
  `
  return twoBucketAllowed(valkey, id, 'attach', caps?.abuse_attach_count_link_max, caps?.abuse_attach_count_session_max)
}

// #274 / ADR-135 §4: guest per-file SIZE cap, checked at confirm against the authoritative HeadObject
// size (client-supplied sizes are never trusted). NULL/≤0 = unlimited, mirroring normalizeRateMax.
export async function guestAttachMaxBytes(db: TenantDb, tenantId: string): Promise<number> {
  const [caps] = await db.sql<[{ abuse_attach_guest_max_bytes: string | number | null }?]>`
    SELECT abuse_attach_guest_max_bytes FROM tenant_settings WHERE tenant_id = ${tenantId}
  `
  return normalizeRateMax(caps?.abuse_attach_guest_max_bytes == null ? null : Number(caps.abuse_attach_guest_max_bytes))
}

// #449 / ADR-173 §1: the guest SEARCH cap — same two-bucket window as publish/create/attach, so a
// share link opened to the public cannot be turned into a query firehose against Meili + FGA. NULL =
// unlimited (self-host pays nothing). Members are never capped here (unchanged).
export async function guestSearchRateAllowed(valkey: IORedis, db: TenantDb, id: GuestRateIdentity): Promise<boolean> {
  const [caps] = await db.sql<[{ abuse_search_rate_link_max: number | null; abuse_search_rate_session_max: number | null }?]>`
    SELECT abuse_search_rate_link_max, abuse_search_rate_session_max FROM tenant_settings WHERE tenant_id = ${id.tenantId}
  `
  return twoBucketAllowed(valkey, id, 'search', caps?.abuse_search_rate_link_max, caps?.abuse_search_rate_session_max)
}
