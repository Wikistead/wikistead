import type { FastifyInstance } from 'fastify'
import { filterAuthorized, fgaClient } from '@wikistead/authz'
import { fillAuthorizedPage, SEARCH_CANDIDATE_LIMIT } from '../search/paginate.js'

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

    // Resume offset (opaque cursor). A tampered cursor only re-positions the ranked scan — it
    // can never leak an unauthorized hit (stage-2 FGA filters every window) — but bound it anyway.
    const start = Number(req.query.cursor)
    const startOffset = Number.isInteger(start) && start > 0 ? start : 0

    const { results, nextCursor } = await fillAuthorizedPage(
      (offset, limit) => app.searchDriver.search({
        tenantId: req.tenant.id, userId: req.user.sub, groups: req.user.groups, q, spaceId: req.query.spaceId, offset, limit,
      }),
      (ids) => filterAuthorized(fgaClient, `user:${req.user.sub}`, 'view', ids), // stage-2: authoritative
      { startOffset, windowSize: SEARCH_CANDIDATE_LIMIT },
    )

    // Never a silent cap: nextCursor (and the back-compat has-more flag) signal + ENABLE more.
    reply.header('X-Search-Has-More', String(nextCursor != null))
    if (nextCursor != null) reply.header('X-Search-Cursor', String(nextCursor))
    return results
  })
}
