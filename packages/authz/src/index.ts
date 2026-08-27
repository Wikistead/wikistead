export { makeFga, fgaClient, fgaModelId } from './client.js'
// #253: the DSL transform and its canonical comparison, in one place — apps/server's guard and
// infra/openfga's drift-healer both consume this rather than keeping their own copies.
export { dslToModel, canonicalModel, modelsMatch } from './model.js'
export { check, checkRelation, checkMemberAccess, filterAuthorized } from './check.js'
export { isTenantAdmin, requireTenantAdmin, requireTenantAdminOr404, isSpaceCreator, isApiKeyIssuer, isConnectionManager, requireConnectionManager, isRoleManager, requireRoleManager, isAuditReader, requireAuditReader, isTenantMember } from './tenant-admin.js' // #383: one tenant-admin gate (+ #445 space_creator, #496 api_key_issue, #471 membership)
export type { CheckContext, MemberAccess } from './check.js'
export { writeTuples, deleteTuples, deleteObjectTuples, readObjectTuples, readObjectTuplesPage, readUserTuplesByType, FGA_WRITE_CHUNK, isAlreadyConverged } from './tuples.js' // #578: convergence is asked by code, never by matching the store's prose
export type { TupleInput } from './tuples.js'
// #637 / ADR-216 §1: the ambient authorization scope (see scope.ts for why it is ambient).
export { runInAuthzScope, openAuthzScope, setAuthzRestriction, setAuthzApiKey, currentAuthzScope, requireAuthzScope, resetAuthzScopeRequirement, authzScopeForCheck, SYSTEM_SCOPE } from './scope.js'
export type { AuthzScope } from './scope.js'
// #637 / ADR-216 §5, §7: the AND at the primitives — CE owns the seam and the refusal, EE the rule.
export { registerAuthzRestrictionEvaluator, getAuthzRestrictionEvaluator, resetAuthzRestrictionEvaluator, restrictionAllows } from './restriction.js'
export type { AuthzRestrictionEvaluator } from './restriction.js'
// #758 / ADR-183 §3: the observation port for a thinned batch. A sink cannot change a verdict.
export { registerAuthzDegradationSink, resetAuthzDegradationSink, hasAuthzDegradationSink } from './degradation.js'
export type { AuthzDegradation, AuthzDegradationSink } from './degradation.js'
// #831: one formula for a group's store id. It was copied into the rebuild script with a different
// separator, so a recovery run wrote every group membership under an id nobody grants to — silently,
// and reporting success. A shared comment asking two files to agree is not a mechanism.
export { groupFgaId, groupGrantee } from './group-id.js'
