// #700: a PRIVATE TENANT for suites that write per-(tenant, sub) slots — factor rows, the one
// passkey challenge (`passkeychal:<tenant>:<sub>`), the failure counter and its lock, the
// last-admin floor, and tenant-wide policy (second-factor stance) alike. #666 isolated one file by
// giving it a private MEMBER; a private tenant is the stronger form of the same move: every keyed
// slot AND the tenant-scoped policy become this file's alone, while `dev-user` + the dev bearer
// keep working unchanged (the host header resolves the tenant; the tuples below make dev-user its
// admin — the sso-required-605 fixture shape, extracted so the next suite does not re-derive it).
import type { Sql } from 'postgres'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'

export interface PrivateTenant {
  id: string
  slug: string
  /** Request headers: the dev bearer resolved onto THIS tenant. */
  H: { host: string; authorization: string; 'content-type': string }
  AUTH: { host: string; authorization: string }
  dispose: () => Promise<void>
}

const TUPLES = (id: string) => [
  { user: 'user:dev-user', relation: 'member', object: `tenant:${id}` },
  { user: 'user:dev-user', relation: 'admin', object: `tenant:${id}` },
]

/**
 * Create (idempotently) a tenant owned by this suite file, with dev-user seated as its admin.
 * `slug` must be unique per FILE (convention: `t<ticket>`), so two files never meet in it.
 */
export async function privateTenant(admin: Sql, slug: string, opts?: { plan?: string }): Promise<PrivateTenant> {
  const id = `tenant_${slug}`
  const plan = opts?.plan ?? 'business'
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${id}, ${slug}, ${plan})
              ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${id}, 'dev-user', ${`dev-user@${slug}.test`}, 'admin')
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin', deactivated_at = NULL`
  await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${id}, TRUE)
              ON CONFLICT (tenant_id) DO NOTHING`
  for (const t of TUPLES(id)) await writeTuples(fgaClient, [t]).catch(() => {})
  return {
    id,
    slug,
    H: { host: `${slug}.localhost`, authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    AUTH: { host: `${slug}.localhost`, authorization: 'Bearer dev-token' },
    dispose: async () => {
      for (const t of TUPLES(id)) await deleteTuples(fgaClient, [t]).catch(() => {})
      // Dependents first; the ledger tables are cleaned too — a private tenant's history has no
      // other reader, so the hash-chain caveat that protects tenant_dev's ledger does not apply.
      for (const tbl of ['member_factors', 'audit_outbox', 'audit_log', 'local_credentials', 'password_resets', 'sso_exemptions', 'tenant_oidc', 'tenant_saml', 'tenant_login_prefs', 'role_assignments', 'roles', 'members']) {
        await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${id}'`).catch(() => {})
      }
      await admin`DELETE FROM tenants WHERE id = ${id}`.catch(() => {})
    },
  }
}
