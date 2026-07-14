// CE-published extension point for authorization.
// EE registers hooks here to implement approval workflows, advanced RBAC, etc.
// CE's check() calls these hooks; EE never imports CE's check() directly.
//
// SCOPE (#383 / ADR-152 §1, Option B — ratified 2026-07-15): these hooks interpose on the
// PAGE/SPACE CAPABILITY seam ONLY — i.e. `check()` in @wikistead/authz (and everything built on it,
// e.g. filterAuthorized). They are deliberately NOT global interposition. The following paths do NOT
// route through the hooks, by design, and an EE feature must never assume they do:
//   - tenant-admin gates (isTenantAdmin / requireTenantAdmin* — a raw low-level FGA check),
//   - collab's checkMemberAccess (an edit+view batchCheck deriving RW/RO/reject),
//   - the anonymous public reader's checkRelation calls (routes/public.ts),
//   - listObjects (public tree) and search stage-1 (candidate enumeration).
// A deny that must cover those surfaces belongs in the FGA MODEL as a DSL subtraction (the freeze
// `but not frozen*` / trash `but not trashed` pattern) — OpenFGA then enforces it on EVERY primitive,
// including listObjects. Re-open ADR-152 (Option A) only for a deny that provably cannot be DSL.
// CONTRACT: a hook implementation must not call check() itself (getAuthzHooks → afterCheck would
// re-enter and recurse) — use the raw, non-interposed checkRelation for any FGA reads it needs.
//
// Both hooks default to no-op when unregistered.
// beforeCheck: undefined return → proceed to FGA; boolean → short-circuit.
// afterCheck:  undefined return → use FGA result; boolean → override.
import type { ResourceRef } from '@wikistead/types'

export interface AuthzCheckContext {
  user: string            // "user:alice" | "share_link:Y" | "user:anonymous"
  relation: string        // 'view' | 'edit' | 'manage' | 'viewer' | 'manager' ...
  resource: ResourceRef
  tenantId: string
}

export interface AuthzHooks {
  beforeCheck?: (ctx: AuthzCheckContext) => Promise<boolean | undefined>
  afterCheck?:  (ctx: AuthzCheckContext, fgaResult: boolean) => Promise<boolean | undefined>
}

let _hooks: AuthzHooks = {}

export function registerAuthzHooks(hooks: Partial<AuthzHooks>): void {
  _hooks = { ..._hooks, ...hooks }
}

export function getAuthzHooks(): Readonly<AuthzHooks> {
  return _hooks
}
