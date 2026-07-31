// #497 re-review N3 (one-time, LOGICAL tenants): the #553 backfill created the comment sibling of
// every built-in `edit` row WITHOUT looking at origin, so a MAPPING-owned edit row got a MANUAL
// comment row beside it. Two consequences, both measured: the Members screen folds the pair into one
// editor row that wears the mapping badge (no revoke affordance — correct for a machine-managed row),
// so the comment arm cannot be removed from the UI at all; and deleting the mapping strips the edit
// arm while the manual comment row survives, leaving a group that still comments after its mapping
// is gone.
//
// The convergence: where a mapping-owned built-in row exists, its BUNDLE siblings on the same
// (principal, resource) become mapping-owned too — the same ownership the composite create now
// writes from the start (roles.ts builtinBundle). Nothing is granted or revoked here: only `origin`
// moves, so no FGA write, no webhook, no per-row audit. One operator-ledger entry records the pass.
//
// Dry-run is the DEFAULT (--apply executes).
import postgres from 'postgres'
import { pathToFileURL } from 'node:url'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import { builtinBundle } from '../routes/roles.js'

export const MIGRATE_ACTOR = 'operator:converge-497'

export interface MappingCompositePlan {
  rows: { tenantId: string; assignmentId: string; principal: string; resourceId: string; capability: string; primary: string }[]
}

export async function planMappingComposite(admin: postgres.Sql, log: (l: string) => void = console.log): Promise<MappingCompositePlan> {
  for (const t of await admin<{ id: string }[]>`SELECT id FROM tenants WHERE isolation <> 'logical'`) {
    log(`skip tenant ${t.id}: namespace-isolated`)
  }
  // every mapping-owned built-in row whose capability HAS a bundle (today: edit → +comment)
  const owners = await admin<{ tenant_id: string; resource_type: string; resource_id: string; principal: string; builtin_capability: string }[]>`
    SELECT a.tenant_id, a.resource_type, a.resource_id, a.principal, a.builtin_capability
    FROM role_assignments a JOIN tenants t ON t.id = a.tenant_id AND t.isolation = 'logical'
    WHERE a.origin = 'mapping' AND a.builtin_capability IS NOT NULL`
  const rows: MappingCompositePlan['rows'] = []
  for (const o of owners) {
    const siblings = builtinBundle(o.builtin_capability).filter((c) => c !== o.builtin_capability)
    if (!siblings.length) continue
    const strays = await admin<{ id: string; builtin_capability: string }[]>`
      SELECT id, builtin_capability FROM role_assignments
      WHERE resource_type = ${o.resource_type} AND resource_id = ${o.resource_id} AND principal = ${o.principal}
        AND origin <> 'mapping' AND builtin_capability = ANY(${siblings})`
    for (const s of strays) {
      rows.push({
        tenantId: o.tenant_id, assignmentId: s.id, principal: o.principal,
        resourceId: o.resource_id, capability: s.builtin_capability, primary: o.builtin_capability,
      })
    }
  }
  return { rows }
}

export async function executeMappingComposite(admin: postgres.Sql, plan: MappingCompositePlan, log: (l: string) => void = console.log): Promise<void> {
  for (const r of plan.rows) {
    // per-item, so one surprising row cannot abandon the rest mid-pass
    try {
      await admin`UPDATE role_assignments SET origin = 'mapping' WHERE id = ${r.assignmentId} AND origin <> 'mapping'`
      log(`converged ${r.capability} for ${r.principal} on ${r.resourceId} (beside the mapping-owned ${r.primary})`)
    } catch (e) {
      log(`FAILED ${r.assignmentId}: ${(e as Error).message}`)
    }
  }
  await admin.begin(async (tx) => {
    await appendOperatorEntry(tx, {
      actor: MIGRATE_ACTOR,
      action: 'authz.mapping_composite_converged',
      target: '',
      at: new Date().toISOString(),
      reason: 'maintenance',
    })
  })
  log(`ledger: ${plan.rows.length} sibling row(s) converged to mapping ownership`)
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const APPLY = process.argv.includes('--apply')
  const admin = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const plan = await planMappingComposite(admin)
    if (!APPLY) {
      console.log(`DRY-RUN: ${plan.rows.length} sibling row(s) would become mapping-owned`)
      for (const r of plan.rows) console.log(`  ${r.capability} ${r.principal} @ ${r.resourceId}`)
    } else {
      await executeMappingComposite(admin, plan)
    }
  } finally {
    await admin.end()
  }
}
