import type { TupleInput } from '@wikistead/authz'

// #471 / ADR-176: since a request principal must be a member of the tenant it is used against, a
// fixture that invents a sub has to say so — a `members` ROW is not the authority, the FGA
// `tenant#member` tuple is (the same predicate login checks, and the one provisioning writes).
// Before the binding these fixtures worked without it, which is precisely the hole #471 closed.
export const memberTuples = (tenantId: string, subs: string[]): TupleInput[] =>
  subs.map((sub) => ({ user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` }))
