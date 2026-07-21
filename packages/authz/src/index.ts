export { makeFga, fgaClient } from './client.js'
export { check, checkRelation, checkMemberAccess, filterAuthorized } from './check.js'
export { isTenantAdmin, requireTenantAdmin, requireTenantAdminOr404, isSpaceCreator, isTenantMember } from './tenant-admin.js' // #383: one tenant-admin gate (+ #445 space_creator, #471 membership)
export type { CheckContext, MemberAccess } from './check.js'
export { writeTuples, deleteTuples, deleteObjectTuples, readUserTuplesByType } from './tuples.js'
export type { TupleInput } from './tuples.js'
