// #536(5): one-shot convergence of PRE-EXISTING duplicate space-role assignments.
//
// The replace semantics ((2)) stop NEW duplicates from forming, but the recorded "converge on the
// next add" policy left historical stacks visible (measured: one principal wearing four rows on
// demo_space). The user's ruling: clean them up in one pass instead of waiting to be touched.
//
// Rules (the SAME convergence the runtime add applies — sweepOtherSpaceRoles is the engine, so the two
// cannot drift):
//   - scope: space-scope MANUAL rows only. Machine rows (origin mapping/default) are never touched
//     (ADR-183 §1 — the mapping owns them), and `manage` never auto-demotes (owner-lockout rule):
//     a manage row/tuple survives, exactly like the runtime path.
//   - keeper: the STRONGEST role wins — capability rank moderate > edit > comment > view; a custom
//     role ranks by the strongest capability in its bundle. Tie → the custom role over the built-in
//     (the curated bundle carries more intent), then the newest row (latest intent).
//   - FGA tuples go WITH the rows (unassignRoleInTx — refcount-aware), and legacy ROWLESS leftovers
//     the kept role doesn't cover are swept in the same pass. Search reindex rides along.
//   - every removal is audited through the normal in-tx audit path (space.access_revoked for built-in
//     rows), and each touched tenant gets ONE operator-ledger entry summarizing the run.
//
// Usage (dry-run is the DEFAULT — #499's discipline: see the plan before it executes):
//   pnpm --filter @wikistead/server roles:converge            # print the plan, write nothing
//   pnpm --filter @wikistead/server roles:converge -- --apply # execute
// Needs DATABASE_URL / DATABASE_ADMIN_URL / OPENFGA_* (the same env the server runs with).
import postgres from 'postgres'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { acquireTenantDb } from '../db/index.js'
import { sweepOtherSpaceRoles } from '../routes/spaces.js'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import type { Tenant } from '@wikistead/types'

export const CONVERGE_ACTOR = 'operator:converge-536'

// manage is deliberately ABSENT: it never participates in convergence (rows with it are kept as-is).
const RANK: Record<string, number> = { view: 1, comment: 2, edit: 3, moderate: 4 }

export interface DupRow {
  id: string
  tenant_id: string
  resource_id: string
  principal: string
  role_id: string | null
  builtin_capability: string | null
  capabilities: string[] | null // the custom role's bundle (join)
  created_at: Date
}

export const rankOf = (r: Pick<DupRow, 'builtin_capability' | 'capabilities'>): number =>
  r.builtin_capability != null
    ? RANK[r.builtin_capability] ?? 0
    : Math.max(0, ...(r.capabilities ?? []).map((c) => RANK[c] ?? 0))

// keeper: rank desc → custom over built-in → newest
export const pickKeeper = (rows: DupRow[]): DupRow =>
  [...rows].sort((a, b) =>
    rankOf(b) - rankOf(a)
    || Number(b.role_id != null) - Number(a.role_id != null)
    || b.created_at.getTime() - a.created_at.getTime(),
  )[0]!

export interface ConvergencePlanItem {
  tenantId: string
  spaceId: string
  principal: string
  keep: string
  remove: string[]
  keepRow: DupRow
}

// Enumerate the duplicate groups (>1 manual, non-manage rows for one tenant+space+principal) and pick
// each group's keeper. Read-only — this IS the dry-run output.
export async function planConvergence(admin: postgres.Sql): Promise<ConvergencePlanItem[]> {
  const rows = await admin<DupRow[]>`
    SELECT a.id, a.tenant_id, a.resource_id, a.principal, a.role_id, a.builtin_capability,
           r.capabilities, a.created_at
    FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
    WHERE a.resource_type = 'space' AND a.origin = 'manual'
      AND a.builtin_capability IS DISTINCT FROM 'manage'
      AND (a.tenant_id, a.resource_id, a.principal) IN (
        SELECT tenant_id, resource_id, principal FROM role_assignments
        WHERE resource_type = 'space' AND origin = 'manual'
          AND builtin_capability IS DISTINCT FROM 'manage'
        GROUP BY tenant_id, resource_id, principal HAVING count(*) > 1
      )
    ORDER BY a.tenant_id, a.resource_id, a.principal, a.created_at`
  const groups = new Map<string, DupRow[]>()
  for (const r of rows) {
    const k = `${r.tenant_id} ${r.resource_id} ${r.principal}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.values()].map((g) => {
    const keep = pickKeeper(g)
    return {
      tenantId: keep.tenant_id,
      spaceId: keep.resource_id,
      principal: keep.principal,
      keep: keep.builtin_capability ?? `role:${keep.role_id}`,
      remove: g.filter((r) => r.id !== keep.id).map((r) => r.builtin_capability ?? `role:${r.role_id}`),
      keepRow: keep,
    }
  })
}

// Execute the plan through the runtime convergence engine, then ledger each touched tenant once.
export async function executeConvergence(
  admin: postgres.Sql,
  app: FastifyInstance,
  plan: ConvergencePlanItem[],
  log: (line: string) => void = console.log,
): Promise<void> {
  if (plan.length === 0) return
  const tenants = await admin<{ id: string; slug: string; plan: string; isolation: string }[]>`
    SELECT id, slug, plan, isolation FROM tenants WHERE id IN ${admin([...new Set(plan.map((p) => p.tenantId))])}`
  const byTenant = new Map(tenants.map((t) => [t.id, t]))
  const touched = new Map<string, number>()
  for (const p of plan) {
    const t = byTenant.get(p.tenantId)
    if (!t) { log(`tenant ${p.tenantId} not found — skipped`); continue }
    const db = await acquireTenantDb({ id: t.id, slug: t.slug, plan: t.plan, isolation: t.isolation } as Tenant)
    try {
      const keepCaps = p.keepRow.builtin_capability != null ? [p.keepRow.builtin_capability] : (p.keepRow.capabilities ?? [])
      await sweepOtherSpaceRoles(db, app.fga, app.searchDriver, {
        spaceId: p.spaceId, tenantId: p.tenantId, userId: CONVERGE_ACTOR, principal: p.principal,
        keep: p.keepRow.builtin_capability != null ? { builtinCapability: p.keepRow.builtin_capability } : { roleId: p.keepRow.role_id! },
        keepCaps, plan: t.plan,
      })
      touched.set(p.tenantId, (touched.get(p.tenantId) ?? 0) + p.remove.length)
      log(`converged ${p.principal} on space:${p.spaceId} → kept ${p.keep}, removed ${p.remove.join(', ')}`)
    } finally {
      await db.release()
    }
  }
  // one operator-ledger entry per touched tenant — the durable operator-side record of the sweep
  for (const [tenantId, removed] of touched) {
    await admin.begin(async (tx) => {
      await appendOperatorEntry(tx, {
        actor: CONVERGE_ACTOR,
        action: 'roles.duplicates_converged',
        target: `tenant:${tenantId}`,
        at: new Date().toISOString(),
        reason: 'unspecified',
      })
    })
    log(`ledger: tenant:${tenantId} — ${removed} duplicate assignment(s) removed`)
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const APPLY = process.argv.includes('--apply')
  ;(async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL
    if (!adminUrl) { console.error('DATABASE_ADMIN_URL required'); process.exit(1) }
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
    const plan = await planConvergence(admin)
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${plan.length} principal(s) with duplicate manual space roles`)
    for (const p of plan) console.log(JSON.stringify({ tenantId: p.tenantId, spaceId: p.spaceId, principal: p.principal, keep: p.keep, remove: p.remove }))
    if (!APPLY || plan.length === 0) { await admin.end(); process.exit(0) }
    const app = await buildApp()
    await app.ready()
    await executeConvergence(admin, app, plan)
    await app.close()
    await admin.end()
    console.log('convergence complete')
    process.exit(0)
  })().catch((e) => { console.error(e); process.exit(1) })
}
