// Tenant provisioning + the bounded "first member becomes admin" bootstrap
// (P1.2). The ONLY paths that grant membership besides invite (P1.4):
//   - provisionTenant: Cloud signup creates a NEW tenant with the creator as its
//     sole initial admin, atomically.
//   - bootstrapFirstAdmin: CE — the FIRST OIDC login into an existing, member-less
//     tenant becomes admin, exactly once (an advisory lock makes concurrent
//     first-logins resolve to a single admin). After that, identity≠membership
//     holds fully and 2nd+ logins require an invite.
// Both follow ADR-003: DB writes first, FGA last, throw → full rollback (never a
// half tenant: no admin-less tenant, no FGA ghost).
import type { OpenFgaClient } from '@openfga/sdk'
import { writeTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import type { TenantDb } from '../db/index.js'

// Subdomain slug: a valid DNS label (lowercase alnum + hyphen, no leading/trailing
// hyphen, 1–63 chars) that is not a reserved/used subdomain. A bad slug would
// break Host-based tenant resolution, so this is enforced at creation.
const RESERVED = new Set([
  'www', 'app', 'api', 'auth', 'signup', 'login', 'logout', 'admin', 'status',
  'help', 'docs', 'blog', 'static', 'assets', 'cdn', 'mail', 'public', 'collab', 'dev',
])
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED.has(slug)
}

function adminTuples(tenantId: string, sub: string) {
  return [
    { user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` },
    { user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` },
  ]
}

// Cloud signup: create a tenant and seat the creator as its only admin.
export async function provisionTenant(
  fga: OpenFgaClient,
  args: { slug: string; plan?: string; admin: { sub: string; email?: string | null; name?: string | null } },
): Promise<{ tenantId: string }> {
  if (!isValidSlug(args.slug)) throw Object.assign(new Error('invalid slug'), { statusCode: 400 })

  const tenantId = await pool.begin(async (tx) => {
    // tenants is the global registry (no RLS). UNIQUE(slug) rejects a taken slug
    // (including a concurrent signup) → 409.
    const taken = await tx`SELECT 1 FROM tenants WHERE slug = ${args.slug}`
    if (taken.length) throw Object.assign(new Error('slug taken'), { statusCode: 409 })
    const [t] = await tx<{ id: string }[]>`
      INSERT INTO tenants (slug, plan) VALUES (${args.slug}, ${args.plan ?? 'free'}) RETURNING id`
    // members is tenant-scoped (RLS) — set the context for the new tenant.
    await tx`SELECT set_config('app.tenant_id', ${t.id}, true)`
    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${t.id}, ${args.admin.sub}, ${args.admin.email ?? null}, ${args.admin.name ?? null}, 'admin')`
    // FGA LAST: a failure throws and rolls back the tenant + member (ADR-003).
    await writeTuples(fga, adminTuples(t.id, args.admin.sub))
    return t.id
  })
  return { tenantId }
}

// CE: bootstrap the first admin of an existing member-less tenant. Returns true if
// THIS login became the admin, false if the tenant already had members (caller
// then applies the normal membership gate — i.e., denies an un-invited user).
export async function bootstrapFirstAdmin(
  deps: { db: TenantDb; fga: OpenFgaClient },
  tenant: { id: string },
  claims: { sub: string; email?: string | null; name?: string | null },
): Promise<boolean> {
  return deps.db.tx(async (tx) => {
    // Serialize concurrent first-logins for this tenant so EXACTLY ONE wins.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'bootstrap:' + tenant.id})::bigint)`
    const existing = await tx`SELECT 1 FROM members WHERE tenant_id = ${tenant.id} LIMIT 1`
    if (existing.length) return false // already has members → not the first → no bootstrap
    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, 'admin')`
    await writeTuples(deps.fga, adminTuples(tenant.id, claims.sub)) // FGA last; throw → rollback
    return true
  })
}
