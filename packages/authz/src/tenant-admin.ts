import type { OpenFgaClient } from '@openfga/sdk'

// #383: the ONE tenant-admin gate. Was copy-pasted ~10× (billing / branding / custom-domains / spaces /
// tenant-oidc / enroll-domains / ai / orphan-drafts / members + EE scim/saml/tokens), each doing the same
// `fga.check(admin on tenant:<id>)`. A single divergence would leak the admin boundary, so it lives here.
//
// `tenant` is not a `ResourceRef` type (the RELATION table is page/space only), so this is a RAW `admin`
// relation check — the same low-level call the copies used, behaviour-identical (ADR-152 §2, Option-B seam:
// the tenant-admin gate is NOT routed through the EE hook layer, matching the documented page/space scope).

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
