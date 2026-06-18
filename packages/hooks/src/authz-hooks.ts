// CE-published extension point for authorization.
// EE registers hooks here to implement approval workflows, advanced RBAC, etc.
// CE's check() calls these hooks; EE never imports CE's check() directly.
//
// Both hooks default to no-op when unregistered.
// beforeCheck: undefined return → proceed to FGA; boolean → short-circuit.
// afterCheck:  undefined return → use FGA result; boolean → override.
import type { ResourceRef } from '@kb/types'

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
