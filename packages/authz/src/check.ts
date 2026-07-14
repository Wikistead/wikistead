import type { OpenFgaClient } from '@openfga/sdk'
import type { Capability, ResourceRef } from '@wikistead/types'
import { getAuthzHooks } from '@wikistead/hooks'

export interface CheckContext {
  // ISO 8601 timestamp evaluated against the non_expired condition on share_link tuples.
  current_time?: string
  [key: string]: unknown
}

// Maps user-facing Capability to the FGA relation name per resource type.
// All application-level check() calls go through this table, keeping the
// mapping in one place and preventing typos at call sites.
//
// Page relations mirror Capability names directly.
// Space relations differ (OpenFGA model uses "viewer/editor/manager").
const RELATION: Record<ResourceRef['type'], Partial<Record<Capability, string>>> = {
  page: {
    view:     'view',
    comment:  'comment',
    edit:     'edit',
    manage:   'manage',
    moderate: 'moderate', // #330 / ADR-141: the moderation verb (freeze/revert/patrol; edit via the bypass)
  },
  space: {
    view:     'viewer',
    edit:     'editor',
    manage:   'manager',
    moderate: 'moderator', // #330: a space-level moderator appointment
    // comment: not defined on space
  },
}

function resolveRelation(capability: Capability, resource: ResourceRef): string {
  const rel = RELATION[resource.type]?.[capability]
  if (!rel) {
    throw new Error(`no FGA relation for capability "${capability}" on type "${resource.type}"`)
  }
  return rel
}

// Authorization check. relation is resolved via RELATION table — callers use
// Capability values, not raw FGA relation strings.
//
// EE extension points (from @wikistead/hooks):
//   beforeCheck: may short-circuit before FGA (approval workflow, advanced RBAC).
//   afterCheck:  may override FGA result (additional deny conditions, etc.).
// Both default to no-op when no EE hooks are registered.
export async function check(
  fga: OpenFgaClient,
  user: string,
  capability: Capability,
  resource: ResourceRef,
  context?: CheckContext,
): Promise<boolean> {
  const hooks = getAuthzHooks()
  const relation = resolveRelation(capability, resource)
  const ctx = { user, relation, resource, tenantId: '' }  // tenantId enriched by caller if needed

  const before = await hooks.beforeCheck?.(ctx)
  if (before !== undefined) return before

  const { allowed } = await fga.check({
    user,
    relation,
    object: `${resource.type}:${resource.id}`,
    ...(context ? { context } : {}),
  })
  const fgaResult = Boolean(allowed)

  const after = await hooks.afterCheck?.(ctx, fgaResult)
  return after ?? fgaResult
}

// Low-level check that bypasses the capability→relation mapping.
// Use only for structural/administrative checks (e.g., verifying that a
// specific tuple was written correctly in tests). Prefer check() for all
// application-level authorization — it enforces the type constraint.
export async function checkRelation(
  fga: OpenFgaClient,
  user: string,
  relation: string,
  resource: ResourceRef,
  context?: CheckContext,
): Promise<boolean> {
  const { allowed } = await fga.check({
    user,
    relation,
    object: `${resource.type}:${resource.id}`,
    ...(context ? { context } : {}),
  })
  return Boolean(allowed)
}

// Filter a candidate page list to the authorized subset.
// Used by search: confirm the displayed dozen via OpenFGA before rendering.
export async function filterAuthorized(
  fga: OpenFgaClient,
  user: string,
  capability: Capability,
  pageIds: string[],
  // Optional FGA context (e.g. current_time) — required when `user` is a share_link with a
  // non_expired condition, so a time-bounded guest link is evaluated against the clock.
  context?: CheckContext,
): Promise<Set<string>> {
  const results = await Promise.all(
    pageIds.map((id) =>
      check(fga, user, capability, { type: 'page', id }, context).then((ok) => [id, ok] as const),
    ),
  )
  return new Set(results.filter(([, ok]) => ok).map(([id]) => id))
}

export interface MemberAccess {
  readOnly: boolean
}

// Batch check: one FGA round-trip, three outcomes.
//   canEdit              → { readOnly: false }   (RW entry)
//   !canEdit && canView  → { readOnly: true }    (RO entry)
//   neither              → null                  (reject)
//
// Used in collab onAuthenticate to avoid two sequential FGA requests on the
// hot path for every WebSocket connection.
export async function checkMemberAccess(
  fga: OpenFgaClient,
  userId: string,
  resource: ResourceRef,
): Promise<MemberAccess | null> {
  const object = `${resource.type}:${resource.id}`
  const user = `user:${userId}`
  const { responses } = await fga.batchCheck([
    { user, relation: 'edit', object },
    { user, relation: 'view', object },
  ])
  const canEdit = responses.find((r) => r._request.relation === 'edit')?.allowed ?? false
  const canView = responses.find((r) => r._request.relation === 'view')?.allowed ?? false
  if (canEdit) return { readOnly: false }
  if (canView) return { readOnly: true }
  return null
}
