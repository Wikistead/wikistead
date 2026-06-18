import type { OpenFgaClient } from '@openfga/sdk'
import type { Capability, ResourceRef } from '@kb/types'

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
    view:    'view',
    comment: 'comment',
    edit:    'edit',
    manage:  'manage',
  },
  space: {
    view:   'viewer',
    edit:   'editor',
    manage: 'manager',
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
export async function check(
  fga: OpenFgaClient,
  user: string,
  capability: Capability,
  resource: ResourceRef,
  context?: CheckContext,
): Promise<boolean> {
  const { allowed } = await fga.check({
    user,
    relation: resolveRelation(capability, resource),
    object: `${resource.type}:${resource.id}`,
    ...(context ? { context } : {}),
  })
  return Boolean(allowed)
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
): Promise<Set<string>> {
  const results = await Promise.all(
    pageIds.map((id) =>
      check(fga, user, capability, { type: 'page', id }).then((ok) => [id, ok] as const),
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
