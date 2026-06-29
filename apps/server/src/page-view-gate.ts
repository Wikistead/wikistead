import { check, type CheckContext } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'

// Host-mediated page-view gate (#108 / ADR-071) — the single seam EVERY embedded resource resolves
// through. A principal (`user:<sub>` | `share_link:<id>`) gets an embedded/internal resource ONLY
// after OpenFGA confirms `view` on the resource's OWN page (the attachment-download pattern,
// generalized). Raw resolution (getObject, transclude content) stays auth-bypassing — this is the
// gate the caller MUST pass first, so a macro/embed can never self-authorize (the narrow host-API,
// ADR-024). `context` carries a guest's time so an expired/revoked share_link denies.
//
// Throws 403 on denial (the attachment convention). Embeds that must hide existence (a transclude of
// a page the viewer can't see) wrap this and render an identical denied PLACEHOLDER instead (#108).
export async function assertPageViewable(
  fga: OpenFgaClient,
  principal: string,
  pageId: string,
  context?: CheckContext,
): Promise<void> {
  const canView = await check(fga, principal, 'view', { type: 'page', id: pageId }, context)
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
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
