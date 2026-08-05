// Tenant provisioning + the bounded "first member becomes admin" bootstrap
// (P1.2). The ONLY paths that grant membership besides invite (P1.4):
//   - provisionTenant: Cloud signup creates a NEW tenant with the creator as its
//     sole initial admin, atomically.
//   - (bootstrapFirstAdmin lived here until #616 / ADR-212 retired it — see the note below)
//     it was: CE — the FIRST OIDC login into an existing, member-less
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
    // ADR-171 (#445): seed the "all members may create spaces" default. The member default-role
    // toggle (roles.ts) deletes/re-writes this grant; admins keep creating via `or admin`.
    // #471 / ADR-176: the grant names THIS TENANT'S MEMBERS, not `user:*`. A typed wildcard matches
    // every principal of that type, so what was meant as "all members" read as "anyone the server
    // ever authenticates" — and before the tenant binding that included a stranger from another
    // tenant, who could then create a space they managed here. A userset says what was meant, and
    // needs no per-member tuple to maintain.
    { user: `tenant:${tenantId}#member`, relation: 'space_creator', object: `tenant:${tenantId}` },
  ]
}

// Cloud signup: create a tenant and seat the creator as its only admin.
export async function provisionTenant(
  fga: OpenFgaClient,
  args: { slug: string; plan?: string; admin: { sub: string; email?: string | null; name?: string | null } },
): Promise<{ tenantId: string }> {
  if (!isValidSlug(args.slug)) throw Object.assign(new Error('invalid slug'), { statusCode: 400 })
  // #554 / ADR-197 §5 (S0): a signup whose asserted sub wears a reserved prefix (or FGA-unsafe
  // length) never seats an admin — the seam's own 400, indistinguishable from other bad input.
  const { assertExternalSub } = await import('./reserved-subs.js')
  assertExternalSub(args.admin.sub, () => Object.assign(new Error('invalid signup'), { statusCode: 400 }))

  const tenantId = await pool.begin(async (tx) => {
    // tenants is the global registry (no RLS). UNIQUE(slug) rejects a taken slug
    // (including a concurrent signup) → 409.
    const taken = await tx`SELECT 1 FROM tenants WHERE slug = ${args.slug}`
    if (taken.length) throw Object.assign(new Error('slug taken'), { statusCode: 409 })
    const [t] = await tx<{ id: string }[]>`
      INSERT INTO tenants (slug, plan) VALUES (${args.slug}, ${args.plan ?? 'free'}) RETURNING id`
    // members is tenant-scoped (RLS) — set the context for the new tenant. #382: this stays a
    // hand-written set_config DELIBERATELY: the tenant row was created two statements up IN THIS tx
    // (not yet visible to the registry/driver), and a brand-new tenant is 'logical' by definition —
    // this is tenant BOOTSTRAP inside the global-registry tx, not a driver bypass for an existing one.
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

// #616 / ADR-212 (user ruling 2026-08-05): `bootstrapFirstAdmin` lived here — the first person to
// complete an OIDC login into a member-less tenant became its administrator. It is gone, and the
// entrances are `provisionTenant` (signup) and `pnpm tenant:local-admin` (the operator route). What
// removed it was ADR-198's earlier ruling that a tenant is never created without an admin: that took
// away the situation this answered, leaving a third way to become an administrator which was reachable
// by whoever logged in first.
//
// `adminTuples` above is shared with the surviving entrance, so the shape of "what an admin holds" is
// still stated once.
