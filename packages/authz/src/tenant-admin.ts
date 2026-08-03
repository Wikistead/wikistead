import type { OpenFgaClient } from '@openfga/sdk'

// #383: the ONE tenant-admin gate. Was copy-pasted ~10× (billing / branding / custom-domains / spaces /
// tenant-oidc / enroll-domains / ai / orphan-drafts / members + EE scim/saml/tokens), each doing the same
// `fga.check(admin on tenant:<id>)`. A single divergence would leak the admin boundary, so it lives here.
//
// `tenant` is not a `ResourceRef` type (the RELATION table is page/space only), so this is a RAW `admin`
// relation check — the same low-level call the copies used, behaviour-identical (ADR-152 §2, Option-B seam:
// the tenant-admin gate is NOT routed through the EE hook layer, matching the documented page/space scope).

// #471 / ADR-176: is `userId` a member of `tenantId`? THE membership predicate — the same relation
// login has always checked (`establishMemberSession`), now also asked of every principal a request
// resolves, so identity can never be mistaken for membership. FGA is the authority rather than a
// `members` row: the model defines `member: [user, group#member]`, so a group-derived member (SCIM,
// roles) is a member, and a row read would be a second authority free to drift from this one.
export async function isTenantMember(fga: OpenFgaClient, userId: string, tenantId: string): Promise<boolean> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'member', object: `tenant:${tenantId}` })
  return !!allowed
}

// The bare predicate — true iff `userId` is an admin of `tenantId`.
export async function isTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<boolean> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  return !!allowed
}

// Throwing gate → 403 "admin only" (the shape the routes map to a 403 response).
export async function requireTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  if (!(await isTenantAdmin(fga, userId, tenantId))) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}

// Existence-hiding variant → 404 "not found" (used where revealing "you're not an admin" would confirm the
// resource exists; e.g. the orphan-draft admin recovery surface).
export async function requireTenantAdminOr404(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  if (!(await isTenantAdmin(fga, userId, tenantId))) throw Object.assign(new Error('not found'), { statusCode: 404 })
}

// #445 / ADR-171: may `userId` create SHARED spaces in this tenant? A raw `space_creator` relation
// check on the tenant object (the tenant-admin precedent above: `tenant` is not a ResourceRef type,
// and tenant-scoped gates are deliberately outside the ADR-152 EE hook seam). The relation unions
// the wildcard default, custom tenant-role leaves and `or admin` — ONE check, no settings/branching.
export async function isSpaceCreator(fga: OpenFgaClient, userId: string, tenantId: string): Promise<boolean> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'space_creator', object: `tenant:${tenantId}` })
  return !!allowed
}

// #496 / ADR-181: may `userId` MINT an API key in this tenant? The exact `isSpaceCreator` shape one type
// over: a raw `api_key_issue` check on the tenant object, whose `or admin` arm means an admin (and the
// bootstrap admin) passes without a separate isTenantAdmin call. This is the ONLY authority — it replaces
// #462's `api_key_issue_policy` enum, so there is no settings read and no branching left at the call site.
// Deliberately NOT entitlement-gated: `customRoles` gates DEFINING/ASSIGNING the role that carries the
// capability, never this runtime check, so an already-granted tuple survives a plan downgrade (ADR-181 §4).
export async function isApiKeyIssuer(fga: OpenFgaClient, userId: string, tenantId: string): Promise<boolean> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'api_key_issue', object: `tenant:${tenantId}` })
  return !!allowed
}

// #604 / ADR-208 (ruling B): may `userId` manage this tenant's SIGN-IN METHODS? Same shape as the two
// above: one relation check on the tenant object, whose `or admin` arm means every current admin passes
// unchanged. The point of the verb is the other direction — somebody who is NOT an admin can be given
// exactly this, which `requireTenantAdmin` could never express.
export async function isConnectionManager(fga: OpenFgaClient, userId: string, tenantId: string): Promise<boolean> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'manage_connections', object: `tenant:${tenantId}` })
  return !!allowed
}

export async function requireConnectionManager(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  if (!(await isConnectionManager(fga, userId, tenantId))) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}
