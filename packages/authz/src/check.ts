import type { OpenFgaClient } from '@openfga/sdk'
import type { Capability, ResourceRef } from '@wikistead/types'
import { getAuthzHooks } from '@wikistead/hooks'
import { fgaModelId } from './client.js' // #500: batchCheck needs the model id passed explicitly

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
    // #420 / ADR-164 increment 1: the split verbs (delete/share/settings admin-class; publish edit-class).
    delete:   'delete',
    share:    'share',
    settings: 'settings',
    publish:  'publish',
  },
  space: {
    view:     'viewer',
    edit:     'editor',
    manage:   'manager',
    moderate: 'moderator', // #330: a space-level moderator appointment
    // #420 / ADR-164: space-scoped capability assignment targets (cascade to pages, private-guarded there).
    delete:   'deleter',
    share:    'sharer',
    settings: 'settings_editor',
    publish:  'publisher',
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
//
// #383 / ADR-152 §1 (Option B): check() is the ONLY interposed primitive — the hooks' whole scope is
// this page/space capability seam. checkRelation / checkMemberAccess / the tenant-admin gate /
// listObjects / search stage-1 are non-interposed BY DESIGN (see authz-hooks.ts for the full list and
// the DSL-subtraction alternative). Enforced by authz-hook-scope-383.test.ts — do not quietly widen
// or narrow which functions consult getAuthzHooks() without re-opening ADR-152.
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
// NON-INTERPOSED (#383 / ADR-152 Option B): EE authz hooks never see this call — which is also what
// makes it safe for a hook implementation to use for its own FGA reads (no re-entry).
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
//
// #500 / ADR-183: server-side BatchCheck (SDK ≥0.8.x `batchCheck` = ONE `/batch-check` round-trip per
// chunk) replaces the #489 per-id fan-out (which was O(N) `fga.check` round-trips — a 155-page tree =
// 155 checks in 7 serial chunks, at the edge of the <1s bar). Now O(N/50) round-trips.
//
// ADR-152 is PRESERVED: every id still passes through the EE `beforeCheck`/`afterCheck` hooks — the
// batch path runs beforeCheck per id FIRST (a hook that short-circuits keeps that id out of the batch),
// the server batch, then afterCheck per id. Silently dropping the hooks would be an authz regression
// (authz-hook-scope-383 pins it on the batch path too).
//
// Error semantics (ADR-183 §3, ratified): an ITEM error (one check errored server-side) denies
// THAT id only — a saturated store degrades to fewer visible items, never a 500. A TRANSPORT error (the
// whole batchCheck throws: network / 5xx / validation) PROPAGATES — turning it into "deny all" would
// return 200 + empty, the lying-empty the #500 frontend fix exists to prevent.
export async function filterAuthorized(
  fga: OpenFgaClient,
  user: string,
  capability: Capability,
  pageIds: string[],
  // Optional FGA context (e.g. current_time) — required when `user` is a share_link with a
  // non_expired condition, so a time-bounded guest link is evaluated against the clock.
  context?: CheckContext,
): Promise<Set<string>> {
  const hooks = getAuthzHooks()
  // The relation is the same for every page id (depends only on capability + type), so resolve once.
  const relation = resolveRelation(capability, { type: 'page', id: '' })
  const out = new Set<string>()

  // 1. beforeCheck per id (ADR-152). A hook may short-circuit before FGA; short-circuited ids never
  //    enter the batch. Common case (no EE hooks): beforeCheck is undefined, so this is a cheap pass.
  const toBatch: string[] = []
  for (const id of pageIds) {
    if (hooks.beforeCheck) {
      const before = await hooks.beforeCheck({ user, relation, resource: { type: 'page', id }, tenantId: '' })
      if (before !== undefined) { if (before) out.add(id); continue }
    }
    toBatch.push(id)
  }

  // 2. server-side BatchCheck, chunked at the server's default max (50). The chunks run SEQUENTIALLY —
  //    #489's pacing: one batch in flight per caller, so a big confirm can't monopolise the store.
  for (let i = 0; i < toBatch.length; i += BATCH_CHECK_MAX) {
    const chunk = toBatch.slice(i, i + BATCH_CHECK_MAX)
    // Index-based correlation ids (not the page id) so any id shape is safe against the id charset/length
    // constraint on correlation_id; map the response back by correlation id.
    const byCorr = new Map(chunk.map((id, j) => [String(j), id]))
    const { result } = await fga.batchCheck({
      checks: chunk.map((id, j) => ({
        user,
        relation,
        object: `page:${id}`,
        correlationId: String(j),
        ...(context ? { context } : {}),
      })),
    }, { authorizationModelId: fgaModelId() })
    // Walk the response by correlation id. Fail closed: an id with NO response entry is simply never
    // added to `out` (a missing verdict is a deny, never a silent allow).
    for (const r of result) {
      const id = byCorr.get(r.correlationId)
      if (id === undefined) continue
      // item error → deny that id (ADR-183 §3). Do not consult afterCheck on an errored item.
      if (r.error) continue
      const fgaAllowed = Boolean(r.allowed)
      const final = hooks.afterCheck
        ? (await hooks.afterCheck({ user, relation, resource: { type: 'page', id }, tenantId: '' }, fgaAllowed) ?? fgaAllowed)
        : fgaAllowed
      if (final) out.add(id)
    }
    // Any chunk id with no response entry is denied (fail closed) — never silently treated as allowed.
  }
  return out
}
// The server's default maxChecksPerBatchCheck (#500 / ADR-183). One `/batch-check` round-trip per chunk.
const BATCH_CHECK_MAX = 50

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
// NON-INTERPOSED (#383 / ADR-152 Option B): EE authz hooks do not run here — the 3-value RW/RO/reject
// derivation has no single (relation, boolean) for a hook to act on, and the collab hot path stays a
// pure model evaluation. A deny that must reach collab is a DSL subtraction (freeze/trash pattern).
export async function checkMemberAccess(
  fga: OpenFgaClient,
  userId: string,
  resource: ResourceRef,
): Promise<MemberAccess | null> {
  const object = `${resource.type}:${resource.id}`
  const user = `user:${userId}`
  // #500 / ADR-183: SDK ≥0.8.x — `batchCheck({ checks })` is the server-side `/batch-check` call and
  // returns `{ result }` (was `{ responses }` with `_request` in 0.7.0's client-side fan-out). Correlate
  // by the request relation, exactly as before. Still one round-trip on the collab hot path.
  const { result } = await fga.batchCheck({
    checks: [
      { user, relation: 'edit', object, correlationId: 'edit' },
      { user, relation: 'view', object, correlationId: 'view' },
    ],
  }, { authorizationModelId: fgaModelId() })
  const canEdit = result.find((r) => r.request.relation === 'edit')?.allowed ?? false
  const canView = result.find((r) => r.request.relation === 'view')?.allowed ?? false
  if (canEdit) return { readOnly: false }
  if (canView) return { readOnly: true }
  return null
}
