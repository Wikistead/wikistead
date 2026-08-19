import type { OpenFgaClient } from '@openfga/sdk'
import type { Capability, ResourceRef } from '@wikistead/types'
import { authzScopeForCheck } from './scope.js'
import { restrictionAllows } from './restriction.js'
import { reportAuthzDegradation } from './degradation.js'
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
    // #529 / ADR-193: comment IS a space capability now (space#commenter), inherited by pages via
    // comment_from_space (private-guarded).
    comment:  'commenter',
    // ADR-209 (#607): the membership verb — runs the roster, never the space (the ceiling is
    // application-level; `or manager` means every manager passes this check too).
    manageAccess: 'access_manager',
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
  // #637 / ADR-216 §1: in a process that declared `requireAuthzScope()`, a check outside a scope is a
  // programming error and throws here. Nothing is evaluated against the scope yet — that is the next
  // slice — but the teeth come first: a restriction added to a mechanism that silently tolerates its
  // own absence is a restriction that will be forgotten somewhere and never noticed.
  authzScopeForCheck()
  // #637 / ADR-216 §5: the restriction ANDs with the answer — it never replaces it. A key confined to a
  // space still cannot reach what its owner cannot, and its owner's rights do not extend it past the
  // confinement. Asked first because it is the cheaper of the two and the one that can say no on its own.
  if (!(await restrictionAllows(resource))) return false
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
  // #637: the same AND. `check` alone would leave every listing surface open — the tree, the space
  // roster and the public walk all ask through this one, not through `check`.
  if (!(await restrictionAllows(resource))) return false
  const { allowed } = await fga.check({
    user,
    relation,
    object: `${resource.type}:${resource.id}`,
    ...(context ? { context } : {}),
  })
  return Boolean(allowed)
}

// Filter a candidate id list to the authorized subset for one capability, in ONE batched round-trip per
// chunk. Used by search (confirm the displayed dozen), the page tree, and #489 the space list (batching
// each of a space's capabilities). The resource type defaults to 'page'; pass 'space' for a space list.
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
  ids: string[],
  // Optional FGA context (e.g. current_time) — required when `user` is a share_link with a
  // non_expired condition, so a time-bounded guest link is evaluated against the clock.
  context?: CheckContext,
  // #489: the resource type these ids belong to. Defaults to 'page', so every existing page caller is
  // byte-identical; listSpaces passes 'space' to batch its per-space capability fan-out the same way the
  // page tree does. The capability→relation mapping already differs per type (RELATION[type]).
  resourceType: ResourceRef['type'] = 'page',
  // #534: how many 50-id batches may be in flight at once. ONE by default — #489's pacing, so a large
  // confirm cannot monopolise the store — but a caller whose set is big AND whose result is an enhancement
  // rather than a gate may raise it. The title dictionary is the case that forced this: capped at 2000 ids,
  // it is up to 40 SEQUENTIAL round-trips, which is the measured ~14s before the editor opens. Bounded, not
  // unbounded: the point of #489 was never "one at a time", it was "not all at once".
  concurrency = 1,
  // #541stop asking when nobody is listening. A big confirm whose requester has gone away (the
  // tab navigated, the cold probe context closed) kept running its remaining batch waves and STARVED the
  // next page-open's interactive checks — measured as the sidebar's bimodal 2.7s/7.8s. Checked between
  // waves only; aborting THROWS (the caller's response is dead anyway), it never fabricates a verdict —
  // no id is allowed or denied by an abort, so authz semantics are untouched.
  signal?: AbortSignal,
): Promise<Set<string>> {
  const hooks = getAuthzHooks()
  // The relation is the same for every id (depends only on capability + type), so resolve once.
  const relation = resolveRelation(capability, { type: resourceType, id: '' })
  const out = new Set<string>()

  // 1. beforeCheck per id (ADR-152). A hook may short-circuit before FGA; short-circuited ids never
  //    enter the batch. Common case (no EE hooks): beforeCheck is undefined, so this is a cheap pass.
  const toBatch: string[] = []
  for (const id of ids) {
    // #637 / ADR-216 §5: the restriction is applied BEFORE the hooks and before the batch. Filtering
    // afterwards would be the same answer at ten times the cost — and it would send the confined ids to
    // FGA and to any EE hook, which is a list of what the caller asked about that it had no business
    // asking. This is also the primitive the listing surfaces use, so leaving it out here would leave
    // the tree, search stage 2 and the space roster unconfined while `check` looked correct.
    if (!(await restrictionAllows({ type: resourceType, id }))) continue
    if (hooks.beforeCheck) {
      const before = await hooks.beforeCheck({ user, relation, resource: { type: resourceType, id }, tenantId: '' })
      if (before !== undefined) { if (before) out.add(id); continue }
    }
    toBatch.push(id)
  }

  // 2. server-side BatchCheck, chunked at the server's default max (50). The chunks run SEQUENTIALLY —
  //    #489's pacing: one batch in flight per caller, so a big confirm can't monopolise the store.
  const chunks: string[][] = []
  for (let i = 0; i < toBatch.length; i += BATCH_CHECK_MAX) chunks.push(toBatch.slice(i, i + BATCH_CHECK_MAX))
  const lanes = Math.max(1, Math.min(Math.trunc(concurrency), 8)) // clamped: never an unbounded fan-out
  const runChunk = async (chunk: string[]) => {
    // Index-based correlation ids (not the page id) so any id shape is safe against the id charset/length
    // constraint on correlation_id; map the response back by correlation id.
    const byCorr = new Map(chunk.map((id, j) => [String(j), id]))
    const { result } = await fga.batchCheck({
      checks: chunk.map((id, j) => ({
        user,
        relation,
        object: `${resourceType}:${id}`,
        correlationId: String(j),
        ...(context ? { context } : {}),
      })),
    }, { authorizationModelId: fgaModelId() })
    // Walk the response by correlation id. Fail closed: an id with NO response entry is simply never
    // added to `out` (a missing verdict is a deny, never a silent allow).
    let unanswered = 0
    let firstError = ''
    for (const r of result) {
      const id = byCorr.get(r.correlationId)
      if (id === undefined) continue
      // item error → deny that id (ADR-183 §3). Do not consult afterCheck on an errored item.
      if (r.error) {
        // #758: counted, not just skipped. This is the branch where a reader loses a row they were
        // entitled to see, and until now it left no trace of any kind — the thinner list is
        // indistinguishable from an honest one. The count is also what #756 below reads to tell a
        // thinned answer from no answer at all.
        unanswered += 1
        if (!firstError) firstError = JSON.stringify(r.error)
        continue
      }
      const fgaAllowed = Boolean(r.allowed)
      const final = hooks.afterCheck
        ? (await hooks.afterCheck({ user, relation, resource: { type: resourceType, id }, tenantId: '' }, fgaAllowed) ?? fgaAllowed)
        : fgaAllowed
      if (final) out.add(id)
    }
    // Any chunk id with no response entry is denied (fail closed) — never silently treated as allowed.

    // #758 / ADR-183 §3 ("accept for v1 … log a warn per degraded batch" — the half never built).
    // Reported AFTER the verdicts are settled and with its result ignored, so the port cannot reach
    // into the answer. `out` is already what it is going to be.
    if (unanswered > 0) {
      reportAuthzDegradation({ relation, resourceType, candidates: chunk.length, unanswered, firstError })
    }

    // #756: a chunk that answered NOTHING is a failure, not a set of denials.
    //
    // ADR-183 §3 already rules this out — a batch-level error "must NOT become deny-all: the tree would
    // then return 200 + empty, which is exactly the lying-empty the #500 frontend fix exists to prevent".
    // But it named only the TRANSPORT error, and the store has a second door to the same room: the call
    // succeeds and every item inside comes back errored. Applying the per-item rule to all of them
    // reaches deny-all by arithmetic. Measured on a CPU-starved store, and on the 2-core public runner
    // where it was a standing red: `18 of 18 answered, 0 allowed, 18 item-errors — deadline_exceeded`,
    // against nine rows sitting in SQL. The reader saw a space with no pages in it.
    //
    // The intended degradation is UNCHANGED: when some ids error, those ids are denied and the caller
    // shows fewer rows. What is refused is the case where nothing was answerable — that is not a verdict
    // about anyone's access, it is the store failing to speak, and it belongs on the error path where
    // the caller's retry already lives.
    //
    // ⚠️ The degradation above is reported FIRST, on purpose: when the store goes silent the operator
    // wants both facts — that a batch was thinned to nothing, and that the request then failed.
    //
    // ⚠️ The message names the store FIRST, and that word is load-bearing. `app.ts`'s error handler
    // withholds the text of anything that speaks FGA's words and answers `authz_store_error` instead,
    // logging the original for the operator. Everything after the colon here — how many checks were in
    // flight, which relation, which type — is for that log. `chunk.length` is a count of CANDIDATES
    // taken before any authorization ran, so on the tree it is "how many pages exist in this branch",
    // private and draft ones included; #623 §4 redesigned the chevron to stop telling a reader exactly
    // that. `relation` is a name out of model.fga (`access_manager`, `settings_editor`), which #619
    // ruled stays inside. Neither may reach a response body, and the anti-test asks the shipped handler,
    // not a copy of its pattern.
    if (chunk.length > 0 && unanswered === chunk.length) {
      throw new Error(
        `openfga answered none of ${chunk.length} checks in a batch ` +
        `(${relation} on ${resourceType}) — refusing to report that as "denied"`)
    }
  }
  // Run the chunks `lanes` at a time. With the default of 1 this is exactly the old sequential loop.
  for (let i = 0; i < chunks.length; i += lanes) {
    // #541: between waves only — an in-flight batch completes; the NEXT wave is what an abandoned
    // request no longer gets to start.
    if (signal?.aborted) throw Object.assign(new Error('filterAuthorized aborted: requester gone'), { name: 'AbortError' })
    await Promise.all(chunks.slice(i, i + lanes).map(runChunk))
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
