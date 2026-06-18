import type { FastifyInstance } from 'fastify'
import { filterAuthorized, fgaClient } from '@wikistead/authz'

export async function searchPlugin(app: FastifyInstance) {
  // GET /search?q=...&spaceId=...
  //
  // Two-stage guard
  // Stage 1 — Meilisearch filter (fast, denormalized viewerUsers/viewerGroups/isPublic).
  // May be slightly stale between FGA change and Meili reindex.
  // Stage 2 — filterAuthorized FGA final check on the candidate set.
  // Authoritative: catches anything Stage 1 missed due to stale state.
  //
  app.get<{ Querystring: { q?: string; spaceId?: string } }>('/search', async (req) => {
    const q = req.query.q?.trim() ?? ''
    if (!q) return []

    // Stage 1: Meilisearch (fast denormalized filter)
    const hits = await app.searchDriver.search({
      tenantId: req.tenant.id,
      userId: req.user.sub,
      groups: req.user.groups,
      q,
      spaceId: req.query.spaceId,
    })
    if (hits.length === 0) return []

    // Stage 2: FGA final authorization check
    const authorized = await filterAuthorized(
      fgaClient,
      `user:${req.user.sub}`,
      'view',
      hits.map(h => h.id),
    )

    return hits.filter(h => authorized.has(h.id))
  })
}
