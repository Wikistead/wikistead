import type { FastifyInstance } from 'fastify'
import { filterAuthorized, fgaClient } from '@wikistead/authz'
import { fillAuthorizedPage, SEARCH_CANDIDATE_LIMIT } from '../search/paginate.js'
import { encodeCursor, decodeCursor, type CursorScope } from '../search/cursor.js'

export async function searchPlugin(app: FastifyInstance) {
  // GET /search?q=...&spaceId=...&cursor=...
  //
  // Two-stage guard
  // Stage 1 — Meilisearch filter (fast, denormalized viewerUsers/viewerGroups/isPublic).
  // May be slightly stale between FGA change and Meili reindex.
  // Stage 2 — filterAuthorized FGA final check on the candidate set.
  // Authoritative: catches anything Stage 1 missed due to stale state.
  //
  // MeiliFGA Deep pagination (#103/ADR-068)
  // we scan ranked candidate WINDOWS under a bounded budget, filtering each by FGA, so an
  // authorized hit past the first window stays REACHABLE via `cursor` (not just signalled).
  app.get<{ Querystring: { q?: string; spaceId?: string; cursor?: string } }>('/search', async (req, reply) => {
    const q = req.query.q?.trim() ?? ''
    if (!q) return []

    // Resume offset from a SIGNED opaque cursor (#103 / ADR-068): HMAC-bound to this tenant +
    // principal + query, so it can't be read, tampered, or reused across queries/principals. Any
    // failure decodes to 0 (restart) — no error oracle. Stage-2 FGA still filters every window, so a
    // forged offset could at most re-position the scan, never leak an unauthorized hit.
    const scope: CursorScope = { tenantId: req.tenant.id, principal: req.user.sub, q, spaceId: req.query.spaceId }
    const startOffset = decodeCursor(req.query.cursor, scope)

    const { results, nextCursor } = await fillAuthorizedPage(
      (offset, limit) => app.searchDriver.search({
        tenantId: req.tenant.id, userId: req.user.sub, groups: req.user.groups, q, spaceId: req.query.spaceId, offset, limit,
      }),
      (ids) => filterAuthorized(fgaClient, `user:${req.user.sub}`, 'view', ids), // stage-2: authoritative
      { startOffset, windowSize: SEARCH_CANDIDATE_LIMIT },
    )

    // Never a silent cap: the cursor (and the back-compat has-more flag) signal + ENABLE more. The
    // has-more flag reflects the SCAN budget / candidate stream (not the authorized count), and the
    // cursor is opaque, so neither reveals to an unauthorized viewer whether authorized hits exist.
    reply.header('X-Search-Has-More', String(nextCursor != null))
    if (nextCursor != null) reply.header('X-Search-Cursor', encodeCursor(nextCursor, scope))
    return results
  })
}
