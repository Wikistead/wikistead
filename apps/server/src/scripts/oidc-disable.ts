// Break-glass: disable a tenant's own OIDC when its IdP has broken AFTER enabling,
// locking every member out of login (#105 / ADR-060).
//
//   pnpm tenant:oidc-disable <tenantSlug> [--by=<operator>]
//
// This is an OPERATOR action, NOT a tenant-facing backdoor. There is deliberately
// NO HTTP recovery route (that would be an unauthenticated backdoor). It runs only
// with operator DB credentials (DATABASE_ADMIN_URL — the admin role bypasses RLS so
// no tenant session is needed) and:
//   - sets tenant_oidc.enabled = false (disable-only — the config is PRESERVED so the
//     admin can fix and re-enable after regaining access; we never clear it);
//   - emits a `tenant.oidc_recovered` audit event + a structured log line (who/when);
//   - is idempotent (already-disabled / no-config → no-op) and makes no network call.
// It grants NO access and seats no one — `resolveLoginConfig` simply falls back to the
// platform IdP (Cloud) or "no OIDC" (CE), so normal login resumes; OpenFGA stays the
// authz truth (ADR-060).
import os from 'node:os'
import postgres from 'postgres'
import { emit } from '@wikistead/events'
import { appendOperatorEntry } from '../audit/operator-ledger.js'

export interface OidcDisableResult {
  tenantId: string
  slug: string
  hadConfig: boolean // a tenant_oidc row existed
  changed: boolean   // it was enabled and we disabled it (false = idempotent no-op)
}

// Disable a tenant's OIDC login gate. `sql` MUST be an admin-role connection (bypasses
// RLS): break-glass runs without any tenant session by design. Throws (code
// 'tenant_not_found') for an unknown slug. The audit event + log line fire only on an
// actual change, so re-runs don't spam the audit trail.
export async function disableTenantOidc(
  sql: postgres.Sql,
  args: { slug: string; operator: string },
): Promise<OidcDisableResult> {
  const [tenant] = await sql<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${args.slug}`
  if (!tenant) {
    throw Object.assign(new Error(`no tenant with slug "${args.slug}"`), { code: 'tenant_not_found' })
  }
  // #554 S1: deterministic first connection; the break-glass disable below deliberately flips ALL
  // of the tenant's oidc connections (recovery wants the whole kind off) — TODO(#554 S4): --connection.
  const [oidc] = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM tenant_oidc WHERE tenant_id = ${tenant.id} ORDER BY sort, id LIMIT 1
  `
  const hadConfig = oidc != null
  if (!oidc || oidc.enabled === false) {
    return { tenantId: tenant.id, slug: args.slug, hadConfig, changed: false }
  }
  const at = new Date().toISOString()
  // Disable-only (preserve issuer/client/secret so recovery is a single re-enable) AND the durable
  // operator-ledger append in ONE transaction (ADR-089 / #179): if the ledger insert fails, the
  // disable rolls back — no unrecorded use of a privileged operator action. The ledger records only
  // integrity fields (never the config/secret), so it is safe to persist. Admin connection required
  // (the operator_audit_log table is operator-only; migration 047).
  await sql.begin(async (tx) => {
    await tx`UPDATE tenant_oidc SET enabled = false, updated_at = now() WHERE tenant_id = ${tenant.id}`
    await appendOperatorEntry(tx, {
      actor: `operator:${args.operator}`,
      action: 'tenant.oidc_recovered',
      target: `tenant:${tenant.id}`,
      at,
    })
  })
  // Defense-in-depth / real-time alerting (NOT the durable record — that is the ledger above).
  emit({ type: 'tenant.oidc_recovered', tenantId: tenant.id, operator: args.operator })
  // Structured log line (who/when/tenant) — a second, human-greppable trace.
  console.log(
    `[break-glass] tenant.oidc_recovered tenant=${tenant.id} slug=${args.slug} ` +
      `operator=${args.operator} at=${at}`,
  )
  return { tenantId: tenant.id, slug: args.slug, hadConfig, changed: true }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) {
    console.error('usage: pnpm tenant:oidc-disable <tenantSlug> [--by=<operator>]')
    process.exit(2)
  }
  const byArg = process.argv.find((a) => a.startsWith('--by='))?.slice('--by='.length)
  const operator = byArg || process.env.WIKISTEAD_OPERATOR || os.userInfo().username || 'unknown'
  // Operator credentials: the admin role bypasses RLS (no tenant session). Fall back to
  // DATABASE_URL for dev convenience, but production operators use DATABASE_ADMIN_URL.
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const r = await disableTenantOidc(adminPool, { slug, operator })
    if (r.changed) {
      console.log(`tenant:oidc-disable: disabled tenant OIDC for "${slug}" — platform/none login restored.`)
    } else if (!r.hadConfig) {
      console.log(`tenant:oidc-disable: "${slug}" has no tenant OIDC config; nothing to do.`)
    } else {
      console.log(`tenant:oidc-disable: "${slug}" tenant OIDC already disabled; nothing to do (idempotent).`)
    }
  } catch (err) {
    console.error(`tenant:oidc-disable: ${(err as Error).message}`)
    process.exit(1)
  } finally {
    await adminPool.end()
  }
}
