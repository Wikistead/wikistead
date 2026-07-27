import type { OpenFgaClient } from '@openfga/sdk'
import { writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { withTenantTx } from '../db/with-tenant.js'
import type { Sql } from 'postgres'
import type { TenantDb } from '../db/index.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { emit } from '@wikistead/events'

// #497 / ADR-183 §2b: tenant admin conferred by an IdP group, MATERIALISED PER USER.
//
// The model is deliberately NOT touched. `tenant#admin` accepts `[user]` only, and this file does not
// change that: option (a) — adding a `group#member` leaf — was rejected because it would hand tenant
// admin to whoever can edit a group in the IdP, with no action on our side, no record of who holds it,
// and no way to revoke short of editing the IdP back. So a mapping is a DECLARATION, and the actual
// grant is written per member at a moment we control (login, SCIM group change, drift sweep), leaving
// `members.admin_origin` behind as provenance.
//
// The whole point of that provenance: a mapping-materialised admin can be taken away when the group
// stops matching, and a hand-appointed one NEVER is. Those two are indistinguishable without it — the
// tuple and the role column look identical — which is why 081 added the column before this code existed.

export type AdminMappingOutcome = 'promoted' | 'demoted' | 'unchanged'

// Ordering follows ADR-003 (the same shape PATCH /members/:sub uses): the DB row moves first and the
// FGA write is LAST INSIDE the same transaction, so a FGA failure rolls the role change back rather
// than leaving the row and the authority disagreeing. Note which side each failure lands on: a failed
// promotion leaves a non-admin, a failed demotion leaves the tuple AND the row saying admin — the
// latter is why the drift sweep exists rather than trusting login to be the only revoker.
async function promote(
  db: TenantDb, fga: OpenFgaClient, tenant: { id: string; plan: string }, sub: string,
): Promise<void> {
  await db.tx(async (tx) => {
    await tx`UPDATE members SET role = 'admin', admin_origin = 'mapping', updated_at = now() WHERE sub = ${sub}`
    await writeTuples(fga, [{ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenant.id}` }])
    await auditIfEntitled(tx, tenant, { actor: `user:${sub}`, action: 'member.role_changed', target: `user:${sub}` })
  })
  emit({ type: 'member.role_changed', tenantId: tenant.id, actorId: sub, targetSub: sub, role: 'admin' })
}

// The demotion itself, against a transaction handle, so the login path (db.tx) and the drift sweep
// (withTenantTx) run the SAME code — including the audit entry, which the sweep previously skipped.
//
// The tuple delete tolerates "already absent". OpenFGA throws when asked to delete a tuple that is not
// there, and a member CAN legitimately be role='admin' + admin_origin='mapping' with no tuple: SCIM
// deprovision (ee-server scim/provision.ts) removes the admin tuple and empties the member's groups but
// leaves the role columns alone. Treating that as a failure is what let ONE such row stop the whole
// sweep — and the sweep is the only revocation path for an admin who never signs in again. Absent is
// the state we wanted, so it counts as done. (The share-link sweeper takes the same "did not exist =
// cleared" position for the same reason.)
async function demoteInTx(
  tx: Sql, fga: OpenFgaClient, tenant: { id: string; plan: string }, sub: string,
): Promise<void> {
  // admin_origin returns to its default: the column describes how the CURRENT admin status was
  // produced, and this member no longer has one. If they are later appointed by hand it stays manual.
  await tx`UPDATE members SET role = 'member', admin_origin = 'manual', updated_at = now() WHERE sub = ${sub}`
  try {
    await deleteTuples(fga, [{ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenant.id}` }])
  } catch (err) {
    if (!/does not exist|did not exist/i.test(String((err as Error)?.message ?? err))) throw err
  }
  await auditIfEntitled(tx, tenant, { actor: `user:${sub}`, action: 'member.role_changed', target: `user:${sub}` })
}

async function demote(
  db: TenantDb, fga: OpenFgaClient, tenant: { id: string; plan: string }, sub: string,
): Promise<void> {
  await db.tx((tx) => demoteInTx(tx, fga, tenant, sub))
  emit({ type: 'member.role_changed', tenantId: tenant.id, actorId: sub, targetSub: sub, role: 'member' })
}

// Would demoting `sub` leave the tenant with no admin at all? PATCH /members/:sub refuses that case
// (409 "cannot demote the last admin") and so does this: a tenant locked out of its own administration
// cannot be repaired from inside the product. A group edit in the IdP must not be able to do what the
// admin console explicitly forbids. The stale admin is visible (admin_origin='mapping' with no matching
// mapping) rather than silently retained.
async function isLastAdmin(db: TenantDb, sub: string): Promise<boolean> {
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM members WHERE role = 'admin' AND sub <> ${sub}`
  return (row?.n ?? 0) === 0
}

// Evaluate one member against this tenant's admin mappings. Idempotent and safe to re-run: it is called
// on every login and every SCIM group change, so a transient failure self-heals at the next one.
//
// `groups` is the member's CURRENT group list (the same members.groups[] the FGA group#member sync and
// the default-role evaluator read), not the raw claim — one source, so the three cannot disagree.
export async function evaluateAdminMapping(
  db: TenantDb,
  fga: OpenFgaClient,
  tenant: { id: string; plan: string },
  sub: string,
  groups: readonly string[],
): Promise<AdminMappingOutcome> {
  const [member] = await db.sql<{ role: string; admin_origin: string }[]>`
    SELECT role, admin_origin FROM members WHERE sub = ${sub}`
  if (!member) return 'unchanged'

  const matched = groups.length > 0
    && (await db.sql`
      SELECT 1 FROM group_admin_mappings WHERE group_name = ANY(${db.sql.array(groups as string[])}) LIMIT 1
    `).length > 0

  if (matched) {
    // Already admin: leave the provenance alone. Overwriting a 'manual' admin with 'mapping' would make
    // them demotable by an IdP group edit — the person appointed them, and only a person may unappoint.
    if (member.role === 'admin') return 'unchanged'
    await promote(db, fga, tenant, sub)
    return 'promoted'
  }

  // No mapping matches. ONLY a materialised admin is touched; a manual admin whose IdP group happens to
  // disappear keeps their appointment.
  if (member.role !== 'admin' || member.admin_origin !== 'mapping') return 'unchanged'
  if (await isLastAdmin(db, sub)) return 'unchanged'
  await demote(db, fga, tenant, sub)
  return 'demoted'
}

// #497 / ADR-183 §2b, the DRIFT RECONCILE the review required at v1. Login is not a revocation path: a
// materialised admin who never signs in again keeps the tuple forever, and since #496 they can hold an
// API key that keeps working without any session at all. So the removal side cannot depend on the
// member showing up — this sweep re-evaluates every materialised admin against the current mappings.
//
// Cross-tenant, so it follows the share-link sweeper's shape: `tenants` has no RLS, and members does, so
// each tenant is read under its own app.tenant_id. Returns how many admins were demoted.
export async function reconcileMaterialisedAdmins(fga: OpenFgaClient): Promise<number> {
  const tenants = await pool<{ id: string; plan: string }[]>`SELECT id, plan FROM tenants`
  let demoted = 0
  for (const tenant of tenants) {
    try {
      const rows = await withTenantTx(tenant.id, async (tx) => tx<{ sub: string; groups: string[] | null }[]>`
        SELECT m.sub, m.groups FROM members m
        WHERE m.role = 'admin' AND m.admin_origin = 'mapping'
          AND NOT EXISTS (
            SELECT 1 FROM group_admin_mappings g
            WHERE g.group_name = ANY(COALESCE(m.groups, ARRAY[]::text[]))
          )`)
      for (const row of rows) {
        // PER ROW, not per tenant. One member the sweep cannot process must not cost every OTHER member
        // in the tenant their revocation — that is exactly how a single SCIM-deprovisioned row silently
        // turned the whole sweep into a no-op, leaving real drifted admins in place indefinitely.
        try {
          // Re-check the last-admin guard inside the loop: demoting several in one sweep must not walk
          // the tenant down to zero admins.
          const others = await withTenantTx(tenant.id, async (tx) => tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM members WHERE role = 'admin' AND sub <> ${row.sub}`)
          if ((others[0]?.n ?? 0) === 0) continue
          await withTenantTx(tenant.id, (tx) => demoteInTx(tx, fga, tenant, row.sub))
          emit({ type: 'member.role_changed', tenantId: tenant.id, actorId: row.sub, targetSub: row.sub, role: 'member' })
          demoted++
        } catch (err) {
          console.error('[reconcileMaterialisedAdmins] could not demote; next sweep retries', { tenantId: tenant.id, sub: row.sub, err })
        }
      }
    } catch {
      // Leave this tenant to the next sweep (its member list was unreadable — FGA/DB down, or the tenant
      // vanished between the registry read and now). Never abort the others.
    }
  }
  return demoted
}

// Start the periodic drift reconcile. Called from the server entry, NOT buildApp — tests drive
// reconcileMaterialisedAdmins directly, so no stray timer leaks into app.inject (the share-link sweeper
// precedent). Coarse by default: drift only appears when an IdP group changes without the member
// signing in, and every login already corrects their own row.
export function startAdminDriftWorker(fga: OpenFgaClient, intervalMs = 900000): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await reconcileMaterialisedAdmins(fga)
    } catch {
      /* next tick retries */
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
