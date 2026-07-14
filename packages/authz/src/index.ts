export { makeFga, fgaClient } from './client.js'
export { check, checkRelation, checkMemberAccess, filterAuthorized } from './check.js'
export { isTenantAdmin, requireTenantAdmin, requireTenantAdminOr404 } from './tenant-admin.js' // #383: one tenant-admin gate
export type { CheckContext, MemberAccess } from './check.js'
export { writeTuples, deleteTuples, deleteObjectTuples, readUserTuplesByType } from './tuples.js'
export type { TupleInput } from './tuples.js'
