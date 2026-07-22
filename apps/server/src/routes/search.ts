import type { FastifyInstance } from 'fastify'
import { filterAuthorized, fgaClient } from '@wikistead/authz'
import { fillAuthorizedPage, SEARCH_CANDIDATE_LIMIT, SEARCH_PAGE_SIZE } from '../search/paginate.js'
import { encodeCursor, decodeCursor, type CursorScope } from '../search/cursor.js'
import { guestSearchRateAllowed } from '../abuse-rate.js'

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
  //
  // #449 / ADR-173: the route ALSO opens to a space share-link guest (`config.guest: 'view'`). A
  // guest search is forced to the link's space, its stage-2 check runs as the share_link principal
  // (with the current_time context time-bounded links need), and its has-more is derived only from
  // the authorized count so the candidate density of pages the guest cannot see never leaks. A
  // guest whose link is a single page — or no guest scope at all — gets a uniform empty result.
  app.get<{ Querystring: { q?: string; spaceId?: string; cursor?: string } }>(
    '/search',
    { config: { guest: 'view' } },
    async (req, reply) => {
      const q = req.query.q?.trim() ?? ''
      if (!q) return []

      const guest = req.guest
      if (guest) {
        // A guest may only search the SPACE their link admits them to. A page-scoped link (or any
        // non-space resource) has no candidate set to search — return the same empty shape a
        // no-results query gives, so nothing distinguishes "not space-scoped" from "no matches".
        if (guest.resource.type !== 'space') return []
        const spaceId = guest.resource.id // the client-supplied spaceId is IGNORED — never trusted

        // Rate cap (ADR-140 shape): per-link + per-session buckets, keyed on the pseudonymous session
        // id, never raw IP. A static 429 reason — nothing about the query or the tenant.
        const okRate = await guestSearchRateAllowed(app.valkey, req.db, { tenantId: req.tenant.id, shareLinkId: guest.shareLinkId, anonId: guest.anonId })
        if (!okRate) { reply.header('Retry-After', '60'); return reply.code(429).send({ error: 'rate limit exceeded', reason: 'search_rate' }) }

        // The cursor is bound to the SHARE_LINK principal, so a member (or another link) can never
        // replay a guest cursor to resume its scan — same no-oracle failure as the member path.
        const scope: CursorScope = { tenantId: req.tenant.id, principal: `share_link:${guest.shareLinkId}`, q, spaceId }
        const startOffset = decodeCursor(req.query.cursor, scope)
        // Time-bounded links carry a non_expired condition; the FGA check must be evaluated against
        // the clock or it fails closed and silently empties every timed link (a correctness bug, not
        // a leak). Permanent links ignore the context.
        const context = { current_time: new Date().toISOString() }

        const { results, nextCursor } = await fillAuthorizedPage(
          (offset, limit) => app.searchDriver.search({
            // stage 1 omits the viewer terms (the denorm has no share_link) and is scoped to the
            // link's space; stage 2 is the fortress.
            tenantId: req.tenant.id, userId: '', groups: [], q, spaceId, offset, limit, omitViewerFilter: true,
          }),
          // stage-2: authoritative. Private / trashed markers enumerate share_link:* (#244 pair),
          // a draft has no page#space edge so view_base_from_space never connects, another space is
          // never in the candidate set, and a revoked link fails this check instantly.
          (ids) => filterAuthorized(fgaClient, `share_link:${guest.shareLinkId}`, 'view', ids, context),
          { startOffset, windowSize: SEARCH_CANDIDATE_LIMIT },
        )

        // has-more from the AUTHORIZED count only: the candidate window includes docs the guest may
        // not see (private/trashed/draft), so signalling on a full window would weakly leak their
        // density. The cursor still resumes the scan regardless (reachability, ADR-068), but the
        // has-more flag reflects only that we filled a page of authorized hits.
        reply.header('X-Search-Has-More', String(results.length >= SEARCH_PAGE_SIZE))
        if (nextCursor != null) reply.header('X-Search-Cursor', encodeCursor(nextCursor, scope))
        return results
      }

      // ── Member path (unchanged) ──────────────────────────────────────────────
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
    },
  )
}
