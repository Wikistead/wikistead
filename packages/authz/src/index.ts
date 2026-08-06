export { makeFga, fgaClient, fgaModelId } from './client.js'
export { check, checkRelation, checkMemberAccess, filterAuthorized } from './check.js'
export { isTenantAdmin, requireTenantAdmin, requireTenantAdminOr404, isSpaceCreator, isApiKeyIssuer, isConnectionManager, requireConnectionManager, isRoleManager, requireRoleManager, isAuditReader, requireAuditReader, isTenantMember } from './tenant-admin.js' // #383: one tenant-admin gate (+ #445 space_creator, #496 api_key_issue, #471 membership)
export type { CheckContext, MemberAccess } from './check.js'
export { writeTuples, deleteTuples, deleteObjectTuples, readObjectTuples, readUserTuplesByType, FGA_WRITE_CHUNK, isAlreadyConverged } from './tuples.js' // #578: convergence is asked by code, never by matching the store's prose
export type { TupleInput } from './tuples.js'
// #637 / ADR-216 §1: the ambient authorization scope (see scope.ts for why it is ambient).
export { runInAuthzScope, openAuthzScope, setAuthzRestriction, setAuthzApiKey, currentAuthzScope, requireAuthzScope, resetAuthzScopeRequirement, authzScopeForCheck, SYSTEM_SCOPE } from './scope.js'
export type { AuthzScope } from './scope.js'
// #637 / ADR-216 §5, §7: the AND at the primitives — CE owns the seam and the refusal, EE the rule.
export { registerAuthzRestrictionEvaluator, getAuthzRestrictionEvaluator, resetAuthzRestrictionEvaluator, restrictionAllows } from './restriction.js'
export type { AuthzRestrictionEvaluator } from './restriction.js'
