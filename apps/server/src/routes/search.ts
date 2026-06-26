import type { FastifyInstance } from 'fastify'
import { filterAuthorized, fgaClient } from '@wikistead/authz'
import { paginateAuthorized } from '../search/paginate.js'

export async function searchPlugin(app: FastifyInstance) {
  // GET /search?q=...&spaceId=...
  //
  // Two-stage guard
  // Stage 1 — Meilisearch filter (fast, denormalized viewerUsers/viewerGroups/isPublic).
  // May be slightly stale between FGA change and Meili reindex.
  // Stage 2 — filterAuthorized FGA final check on the candidate set.
  // Authoritative: catches anything Stage 1 missed due to stale state.
  //
  app.get<{ Querystring: { q?: string; spaceId?: string } }>('/search', async (req, reply) => {
    const q = req.query.q?.trim() ?? ''
    if (!q) return []

    // Stage 1: Meilisearch over-fetches CANDIDATES (denormalized filter). We page AFTER
    // the FGA filter (ADR-027) so authorized hits past the page cutoff aren't silently lost.
    const candidates = await app.searchDriver.search({
      tenantId: req.tenant.id,
      userId: req.user.sub,
      groups: req.user.groups,
      q,
      spaceId: req.query.spaceId,
    })
    if (candidates.length === 0) return []

    // Stage 2: FGA final authorization check on the candidate set (authoritative).
    const authorized = await filterAuthorized(
      fgaClient,
      `user:${req.user.sub}`,
      'view',
      candidates.map(h => h.id),
    )

    // Page the AUTHORIZED set; never return an FGA-unconfirmed candidate. `hasMore` is
    // surfaced (never a silent cap) via a response header so clients can show "more may
    // exist" without a breaking body change.
    const { results, hasMore } = paginateAuthorized(candidates, authorized)
    reply.header('X-Search-Has-More', String(hasMore))
    return results
  })
}
