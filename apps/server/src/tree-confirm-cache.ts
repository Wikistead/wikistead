// #541: a short-lived, per-viewer cache for the page tree's view confirm — the #534 title-dict cache's
// sibling, under the same discipline.
//
// Measured (follow-up): one page-open asks the checker for ~200 tree confirms plus badges, at
// ~7ms of checker CPU each on the dev box REGARDLESS of store size (a freshly-resynced store benches the
// same, so tuple accumulation is not the cost). Two overlapping opens — the reviewer's back-to-back cold
// probe, or a person hopping pages — double the storm, and the second open's every request crawls behind
// the first's checks. The demand is the lever: the SAME viewer asking the SAME space twice within
// seconds should not re-run the whole confirm.
//
// WHAT MAKES THIS SAFE (the #534 argument, unchanged):
//   - The key includes TENANT, VIEWER and SPACE. A confirm set is exactly "which of these pages this
//     principal may see"; nothing is shared across principals.
//   - Entries expire on TTL AND are dropped for the tenant on the same trusted invalidation signal the
//     title-dict cache uses (the outbox reindex publisher — which fires for permission changes too,
//     because revocation goes through reindex). The generation counter refuses a write that started
//     before an invalidation landed (the #534 race rule: fail toward slow, never toward stale).
//   - A page id NOT in the cached verdicts (created after the entry) is NEVER assumed — the caller
//     confirms the delta against FGA. Absent stays absent; a cached DENY stays deny for at most the TTL.
//   - A miss computes. Nothing is ever served stale in place of a fresh answer.
import { titleDictGeneration } from './title-dict-cache.js'

interface Entry { verdicts: Map<string, boolean>; expires: number }

const TTL_MS = 5_000
const MAX_ENTRIES = 500

const cache = new Map<string, Entry>()

const keyFor = (tenantId: string, subject: string, spaceId: string): string => `${tenantId} ${subject} ${spaceId}`

export function getTreeConfirm(tenantId: string, subject: string, spaceId: string, now = Date.now()): Map<string, boolean> | undefined {
  const hit = cache.get(keyFor(tenantId, subject, spaceId))
  if (!hit) return undefined
  if (hit.expires <= now) { cache.delete(keyFor(tenantId, subject, spaceId)); return undefined }
  return hit.verdicts
}

export function setTreeConfirm(
  tenantId: string,
  subject: string,
  spaceId: string,
  verdicts: Map<string, boolean>,
  now = Date.now(),
  // The generation read BEFORE computing (titleDictGeneration — the same counter, bumped by the same
  // trusted invalidation). A mismatch means the world changed mid-compute: refuse the write.
  seenGeneration?: number,
): void {
  if (seenGeneration !== undefined && seenGeneration !== titleDictGeneration(tenantId)) return
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(keyFor(tenantId, subject, spaceId), { verdicts, expires: now + TTL_MS })
}

// #541 part 6: the badge reads beside the confirm — DISPLAY-ONLY facts (lock / freeze glyphs), one
// fga.read per page, ~half of a cache-miss tree's wall. Cached per (tenant, page) under the same TTL
// and the same invalidation; a badge a few seconds stale is a glyph, never an access decision (the
// confirm above is what admits a page at all).
interface BadgeEntry { value: { private: boolean; frozen: 'full' | 'guests' | null }; expires: number }
const badgeCache = new Map<string, BadgeEntry>()

export function getCachedBadge(tenantId: string, pageId: string, now = Date.now()): BadgeEntry['value'] | undefined {
  const hit = badgeCache.get(`${tenantId} ${pageId}`)
  if (!hit) return undefined
  if (hit.expires <= now) { badgeCache.delete(`${tenantId} ${pageId}`); return undefined }
  return hit.value
}

export function setCachedBadge(tenantId: string, pageId: string, value: BadgeEntry['value'], now = Date.now()): void {
  if (badgeCache.size >= 5000) {
    const oldest = badgeCache.keys().next().value
    if (oldest !== undefined) badgeCache.delete(oldest)
  }
  badgeCache.set(`${tenantId} ${pageId}`, { value, expires: now + TTL_MS })
}

// #541 part 6: the freeze/private PRIMITIVES call this the moment they write, so a moderation action
// shows in the tree immediately — the TTL only covers paths with no such signal (none known).
export function invalidatePageBadge(tenantId: string, pageId: string): void {
  badgeCache.delete(`${tenantId} ${pageId}`)
}

// Wired next to invalidateTitleDictCache in app.ts — one signal, all of it.
export function invalidateTreeConfirmCache(tenantId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${tenantId} `)) cache.delete(k)
  for (const k of badgeCache.keys()) if (k.startsWith(`${tenantId} `)) badgeCache.delete(k)
}
