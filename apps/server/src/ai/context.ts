import type { OpenFgaClient } from '@openfga/sdk'
import { filterAuthorized } from '@wikistead/authz'
import type { SearchDriver } from '@wikistead/hooks'
import type { TenantDb } from '../db/index.js'

// FGA-scoped context gathering for AI ask-KB (#130 / ADR-077). The SECURITY core: AI is
// never an authz side-channel. We retrieve candidate pages via search, then apply the SAME
// authoritative FGA `view` filter the /search endpoint uses (filterAuthorized), and assemble
// context ONLY from pages the asking principal can view. A page the principal cannot see can
// never reach the provider — even if search's denormalized index is momentarily stale.
//
// Only PUBLISHED content contributes (published_md) — in-progress drafts never leak into AI
// context. The provider call + egress (consent: provider registered AND tenant-enabled) +
// metering live in the route layer; this primitive performs NO egress (pure authorized
// retrieval), so it is independent of the consent/metering wiring.

export const MAX_CONTEXT_PAGES = 8
export const MAX_CONTEXT_CHARS = 12_000

export interface GatheredContext {
  context: string
  sources: string[] // page ids that contributed, in rank order
}

export async function gatherAuthorizedContext(
  deps: { db: TenantDb; searchDriver: SearchDriver; fga: OpenFgaClient },
  args: { tenantId: string; userSub: string; groups: string[]; question: string },
): Promise<GatheredContext> {
  const hits = await deps.searchDriver.search({
    tenantId: args.tenantId, userId: args.userSub, groups: args.groups, q: args.question, offset: 0, limit: 20,
  })
  if (hits.length === 0) return { context: '', sources: [] }

  const ids = hits.map((h) => h.id)
  // Authoritative stage-2 FGA check (identical to /search). Only view-authorized pages survive.
  const authorized = await filterAuthorized(deps.fga, `user:${args.userSub}`, 'view', ids)
  const orderedIds = ids.filter((id) => authorized.has(id)).slice(0, MAX_CONTEXT_PAGES)
  if (orderedIds.length === 0) return { context: '', sources: [] }

  const parts: string[] = []
  const sources: string[] = []
  let budget = MAX_CONTEXT_CHARS
  for (const id of orderedIds) {
    const [row] = await deps.db.sql<{ id: string; title: string; published_md: string | null }[]>`
      SELECT id, title, published_md FROM pages WHERE id = ${id}`
    if (!row?.published_md) continue // unpublished/empty → never contributes
    const block = `# ${row.title}\n${row.published_md}`.slice(0, Math.max(budget, 0))
    if (!block) break
    parts.push(block)
    sources.push(id)
    budget -= block.length
    if (budget <= 0) break
  }
  return { context: parts.join('\n\n---\n\n'), sources }
}
