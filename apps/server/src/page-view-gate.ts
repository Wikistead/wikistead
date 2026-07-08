import { check, type CheckContext } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'

// Host-mediated page-view gate (#108 / ADR-071) — the single seam EVERY embedded resource resolves
// through. A principal (`user:<sub>` | `share_link:<id>`) gets an embedded/internal resource ONLY
// after OpenFGA confirms `view` on the resource's OWN page (the attachment-download pattern,
// generalized). Raw resolution (getObject, transclude content) stays auth-bypassing — this is the
// gate the caller MUST pass first, so a macro/embed can never self-authorize (the narrow host-API,
// ADR-024). `context` carries a guest's time so an expired/revoked share_link denies.
//
// Throws 404 'not found' on denial (#280 / #262 existence-hiding uniformity): a view-denied embedded
// resource (attachment download, embed, plantuml render, transclude) is INDISTINGUISHABLE from a
// non-existent one — same status AND body ('not found') — so a `view` gate never becomes an existence
// oracle. The message matches the genuine not-found path (e.g. a missing attachment id). This is the
// READ/DISPLAY convention; operation APIs (edit/manage) keep their own 403 gates. Embeds that render a
// placeholder use canViewPage (below) instead of catching this throw (#108).
export async function assertPageViewable(
  fga: OpenFgaClient,
  principal: string,
  pageId: string,
  context?: CheckContext,
): Promise<void> {
  const canView = await check(fga, principal, 'view', { type: 'page', id: pageId }, context)
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 })
}

// Boolean form for callers that render a placeholder rather than throwing (existence-hiding embeds).
export async function canViewPage(
  fga: OpenFgaClient,
  principal: string,
  pageId: string,
  context?: CheckContext,
): Promise<boolean> {
  return (await check(fga, principal, 'view', { type: 'page', id: pageId }, context)) === true
}
