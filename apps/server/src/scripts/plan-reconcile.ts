// Reconciling plan-downgrade commit batch (#131 / ADR-064): `pnpm plan:reconcile`.
//
// A downgrade webhook defers (keeps the old plan, records pending_plan + pending_plan_at). This
// batch commits the downgrades whose grace has elapsed: plan := pending_plan, then clears the
// pending fields. Reconciling + idempotent — it recomputes from the tenant rows each run, so a
// missed/late run self-heals (no reliance on a single timer); a committed downgrade has no
// pending fields, so a re-run skips it (no double-commit). After the commit the tenant's reduced
// entitlements apply to NEW operations through the normal resolver (seat/storage/branding/api
// gates); the existing-overage freeze (deactivation) is a separate enforcement step (ADR-064).
import postgres from 'postgres'
import { emit } from '@wikistead/events'
import { resolveEntitlements } from '@wikistead/entitlements'
import { PLAN_DOWNGRADE_GRACE_S } from '../plan.js'
import { revokeAllCustomDomains } from '../routes/custom-domains.js'

// Freeze EXISTING seat overage on a committed downgrade (ADR-064): deactivate over-cap members,
// NEWEST-first, NEVER an admin (owner-protected — selection is a business placeholder). Reversible
// (data kept; reactivated on re-upgrade) — never a delete. maxSeats=Infinity (self-host UNLIMITED,
// or no Cloud resolver registered) → no-op. Returns how many were deactivated.
async function freezeSeatOverage(sql: postgres.Sql, tenantId: string, newPlan: string): Promise<number> {
  const maxSeats = resolveEntitlements(newPlan).maxSeats
  if (maxSeats === Infinity) return 0
  const active = await sql<{ id: string; role: string }[]>`
    SELECT id, role FROM members WHERE tenant_id = ${tenantId} AND deactivated_at IS NULL
    ORDER BY created_at ASC
  `
  const admins = active.filter((m) => m.role === 'admin')           // always kept (owner-protected)
  const nonAdmins = active.filter((m) => m.role !== 'admin')
  const seatsForNonAdmins = Math.max(0, maxSeats - admins.length)   // admins consume seats first
  const toFreeze = nonAdmins.slice(seatsForNonAdmins)               // newest beyond the cap
  for (const m of toFreeze) {
    // reason='downgrade_freeze' (#134): a frozen member STAYS billable (still counted by
    // billableMemberCount), distinguishing it from a SCIM deprovision (reason='scim') which frees
    // the seat. Restored on re-upgrade.
    await sql`UPDATE members SET deactivated_at = now(), deactivation_reason = 'downgrade_freeze' WHERE id = ${m.id} AND deactivated_at IS NULL`
  }
  return toFreeze.length
}

// Revoke custom domains the committed plan no longer includes (#721 / ADR-230 §2, ruling
// no second grace — the domain goes at the commit, on the same clock as the seat freeze, because
// ADR-064's grace has already run and one clock is easier to explain than two).
//
// UNLIKE the seat freeze this is NOT reversible on re-upgrade: DNS may have moved on in the
// meantime, and re-asserting a domain without a fresh ownership challenge is precisely the takeover
// ADR-065's revocation exists to prevent. The tenant re-adds and re-verifies.
//
// customDomain unlimited (self-host, or no Cloud resolver registered) → no-op, the same shape
// freezeSeatOverage uses for Infinity seats.
async function revokeCustomDomainsIfLost(sql: postgres.Sql, tenantId: string, newPlan: string): Promise<string[]> {
  if (resolveEntitlements(newPlan).customDomain) return []
  return revokeAllCustomDomains(sql, tenantId)
}

export async function reconcilePlans(
  sql: postgres.Sql,
  opts: { graceSeconds?: number } = {},
): Promise<{ committed: number; domainsRevoked: string[] }> {
  const grace = opts.graceSeconds ?? PLAN_DOWNGRADE_GRACE_S
  const due = await sql<{ id: string; plan: string; pending_plan: string }[]>`
    SELECT id, plan, pending_plan FROM tenants
    WHERE pending_plan IS NOT NULL
      AND pending_plan_at + make_interval(secs => ${grace}) <= now()
  `
  let committed = 0
  const domainsRevoked: string[] = []
  for (const t of due) {
    // The `pending_plan = ...` guard avoids racing a concurrent upgrade that cleared pending.
    const res = await sql`
      UPDATE tenants SET plan = ${t.pending_plan}, pending_plan = NULL, pending_plan_at = NULL
      WHERE id = ${t.id} AND pending_plan = ${t.pending_plan}
    `
    if (res.count > 0) {
      // Commit done → enforce the reversible seat freeze for the now-effective lower plan…
      await freezeSeatOverage(sql, t.id, t.pending_plan)
      // …and the IRREVERSIBLE domain revocation, which the batch reports so an operator can clean
      // up the cert-manager Certificates that #235 will one day delete automatically.
      domainsRevoked.push(...(await revokeCustomDomainsIfLost(sql, t.id, t.pending_plan)))
      emit({ type: 'tenant.plan_changed', tenantId: t.id, oldPlan: t.plan, newPlan: t.pending_plan })
      committed++
    }
  }
  return { committed, domainsRevoked }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const { committed, domainsRevoked } = await reconcilePlans(adminPool)
    console.log(`plan:reconcile — committed ${committed} elapsed downgrade(s)`)
    if (domainsRevoked.length > 0) {
      // Printed, never swallowed: until #235 automates it, deleting each domain's Certificate is a
      // human step, and a silent revocation would leave certs for hosts nothing serves.
      console.log(`plan:reconcile — revoked ${domainsRevoked.length} custom domain(s): ${domainsRevoked.join(', ')}`)
      console.log('plan:reconcile — delete their cert-manager Certificates by hand (ADR-065 point (b), automated by #235)')
    }
  } finally {
    await adminPool.end()
  }
}
