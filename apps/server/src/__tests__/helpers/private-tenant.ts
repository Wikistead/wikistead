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
      // #1140: the previous hand-kept table list left out spaces/pages/share_links/tenant_settings/
      // member_identities (among others) — a `DELETE FROM tenants` blocked on one of those FKs was
      // swallowed by a bare `.catch(() => {})`, so the tenant silently survived and the NEXT run's
      // `ON CONFLICT (slug) DO UPDATE` reused it with whatever state the failed run left behind.
      // Fixed the way `infra/db/prune-test-tenants.ts` (#788) fixes the same class of bug: the table
      // set is ASKED OF THE DATABASE, not listed, so a table added next month (or one nobody thought
      // to hand-list, the way this file never had) joins the sweep on its own. A plain `tenant_id`
      // column catches both the FK-constrained tables (spaces, members, ...) and the ones with no FK
      // at all (audit_outbox, analytics_outbox, ...) — a `confrelid = tenants` query alone would miss
      // the latter.
      const tables = (await admin<{ table_name: string }[]>`
        SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenants'`
      ).map((r) => r.table_name)
      // Multi-pass, same as #788: the FKs are NO ACTION, so a table whose rows reference another
      // table in this same set (pages -> spaces, revisions -> pages, ...) may refuse on an early pass
      // and succeed once that one is empty. A table with no FK at all just succeeds on pass one.
      for (let pass = 0; pass < 6 && tables.length; pass++) {
        for (const table of [...tables]) {
          try {
            await admin.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1`, [id])
            tables.splice(tables.indexOf(table), 1)
          } catch { /* still referenced — try again next pass */ }
        }
      }
      if (tables.length > 0) {
        // Do not swallow this: a private tenant that fails to dispose is reused, with its old rows
        // and settings still attached, by the very next run that picks the same slug (#1140's bug).
        throw new Error(
          `privateTenant(${slug}) dispose: ${tables.length} table(s) still reference tenant_id after 6 passes: ${tables.join(', ')}`,
        )
      }
      await admin`DELETE FROM tenants WHERE id = ${id}`
    },
  }
}
