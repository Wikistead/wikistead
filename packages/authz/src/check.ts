import type { OpenFgaClient } from '@openfga/sdk'
import type { Capability, ResourceRef } from '@kb/types'

export interface CheckContext {
  // ISO 8601 timestamp evaluated against the non_expired condition on share_link tuples.
  current_time?: string
  [key: string]: unknown
}

export async function check(
  fga: OpenFgaClient,
  user: string,
  // string (not Capability) because space relations differ from page relations:
  // page uses "manage"/"edit"/"view"; space uses "manager"/"editor"/"viewer".
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
  relation: string,
  pageIds: string[],
): Promise<Set<string>> {
  const results = await Promise.all(
    pageIds.map((id) =>
      check(fga, user, relation, { type: 'page', id }).then((ok) => [id, ok] as const),
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
