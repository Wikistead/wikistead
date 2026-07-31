// #536(5): one-shot convergence of PRE-EXISTING duplicate space-role assignments.
//
// The replace semantics ((2)) stop NEW duplicates from forming, but the recorded "converge on the
// next add" policy left historical stacks visible (measured: one principal wearing four rows on
// demo_space). The user's ruling: clean them up in one pass instead of waiting to be touched.
//
// Rules (removal runs through the runtime's own core — unassignRoleInTx + the engine's covering rule —
// so script and runtime cannot drift on what a removal means):
//   - scope: space-scope MANUAL rows only, LOGICAL-isolation tenants only (a namespace-promoted
//     tenant's public rows are a frozen rollback copy — planning on them would diverge from the live
//     schema; those tenants are reported and skipped). Machine rows (origin mapping/default) are never
//     touched (ADR-183 §1), and `manage` never auto-demotes (owner-lockout rule).
//   - a role carrying any capability OUTSIDE the ordered four (publish/delete/share/settings) is
//     EXEMPT like manage — there is no ruled order between those and view..moderate, so nothing is
//     silently deleted on an invented comparison. The group still converges among its ordered rows.
//   - keeper (among the ordered rows): the STRONGEST wins — moderate > edit > comment > view; a custom
//     role ranks by the strongest capability in its bundle. Tie → the custom role over the built-in
//     (the curated bundle carries more intent), then the newest row (latest intent).
//   - FGA tuples go WITH the rows (unassignRoleInTx — refcount-aware), and legacy ROWLESS leftovers no
//     SURVIVING row covers are swept with the engine's covering rule. Search reindex rides along.
//     Keeper-side row/tuple drift is REPORTED, never repaired (writing tuples is an authz change this
//     script must not make).
//   - every removal is audited through the normal in-tx audit path (space.access_revoked for built-in
//     rows), and each touched tenant gets ONE operator-ledger entry — written even on partial failure,
//     so what actually happened is always on the record.
//
// Usage (dry-run is the DEFAULT — #499's discipline: see the plan before it executes):
//   pnpm --filter @wikistead/server roles:converge            # print the plan, write nothing
//   pnpm --filter @wikistead/server roles:converge -- --apply # execute
// Needs DATABASE_URL / DATABASE_ADMIN_URL / OPENFGA_* (the same env the server runs with).
import postgres from 'postgres'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { buildApp } from '../app.js'
import { acquireTenantDb } from '../db/index.js'
import { RELATION_TO_CAP, reindexPublishedPages } from '../routes/spaces.js'
import { spaceGrantTuplesFor } from '../space-grant-expansion.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { unassignRoleInTx } from '../routes/roles.js'
import { deleteTuples } from '@wikistead/authz'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import type { Tenant } from '@wikistead/types'

export const CONVERGE_ACTOR = 'operator:converge-536'

// manage is deliberately ABSENT: it never participates in convergence (rows with it are kept as-is).
// #536 design-review (A): the rank covers ONLY the linearly-ordered capabilities. A role carrying any
// capability OUTSIDE this order (publish / delete / share / settings — there is no ruled "stronger
// than" between those and the ordered four) is EXEMPT like manage: it is kept, never auto-removed,
// and the group still converges among its ordered rows. Ranking the unknown as 0 would have deleted a
// publish-only role in favour of a bare `view` — a silent capability loss nobody ruled on.
const RANK: Record<string, number> = { view: 1, comment: 2, edit: 3, moderate: 4 }
// Object.hasOwn, not `in`/bare lookup — the space-grant-expansion.ts rule: this is an authz decision
// table, and a bare lookup answers truthy for inherited keys like 'constructor'.
export const isRankedRow = (r: Pick<DupRow, 'builtin_capability' | 'capabilities'>): boolean =>
  r.builtin_capability != null
    ? Object.hasOwn(RANK, r.builtin_capability)
    : (r.capabilities ?? []).length > 0 && (r.capabilities ?? []).every((c) => Object.hasOwn(RANK, c))

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
    ? (Object.hasOwn(RANK, r.builtin_capability) ? RANK[r.builtin_capability]! : 0)
    : Math.max(0, ...(r.capabilities ?? []).map((c) => (Object.hasOwn(RANK, c) ? RANK[c]! : 0)))

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
  // #536null when the keeper is the principal's MANAGER standing rather than a row. That is the
  // production shape — createSpace writes the creator's `manager` leaf with no row at all — so a plan
  // that could only name rows could not express "keep their manager, drop the weaker ones", which is
  // exactly the stack the user still sees. Execute re-checks the manager tuple instead of a row id.
  keepRow: DupRow | null
  removeRows: { id: string; label: string }[]
  // ranked, non-manage capabilities held as ROWLESS tuples that no row covers (legacy pre-086 residue,
  // #536measured: a commenter tuple beside an aaa-role row). Swept by the leftover pass; listed
  // here so the DRY-RUN shows them before anything runs.
  rowlessResidue?: string[]
  // set when the keeper is a manager (row-tracked or rowless) — execute verifies it still stands
  managerKeeper?: boolean
}

// Enumerate the duplicate groups (>1 manual, non-manage, RANKED rows for one tenant+space+principal)
// and pick each group's keeper. Read-only — this IS the dry-run output.
// #536 design-review (D): NAMESPACE-isolated tenants are excluded up front. This planner reads the
// public schema through the admin connection, but execution runs on each tenant's live handle — for a
// physically promoted tenant those are DIFFERENT tables (public keeps the frozen pre-promotion copy for
// rollback), so a plan made here would be a stale snapshot that can neither converge nor go idempotent.
// Those tenants are reported and skipped; run tenant-scoped tooling for them if it ever matters.
// `fga` is optional: when provided, the plan ALSO covers principals whose duplicate is ROWLESS —
// legacy tuples no row covers, sitting beside at least one manual row (the rows are the post-086
// ledger of intent; uncovered residue converges away, exactly what the runtime add would do). A
// principal with NO rows at all is never planned — their tuples may be their only access, and the
// recorded converge-on-next-add policy stays in force for them.
export async function planConvergence(
  admin: postgres.Sql,
  log: (line: string) => void = console.log,
  fga?: OpenFgaClient,
): Promise<ConvergencePlanItem[]> {
  const skipped = await admin<{ id: string }[]>`
    SELECT DISTINCT t.id FROM role_assignments a JOIN tenants t ON t.id = a.tenant_id
    WHERE a.resource_type = 'space' AND t.isolation <> 'logical'`
  for (const t of skipped) log(`skip tenant ${t.id}: namespace-isolated (plan/execute would see different tables)`)
  const rows = await admin<DupRow[]>`
    SELECT a.id, a.tenant_id, a.resource_id, a.principal, a.role_id, a.builtin_capability,
           r.capabilities, a.created_at
    FROM role_assignments a
    LEFT JOIN roles r ON r.id = a.role_id
    JOIN tenants t ON t.id = a.tenant_id AND t.isolation = 'logical'
    WHERE a.resource_type = 'space' AND a.origin = 'manual'
      AND a.builtin_capability IS DISTINCT FROM 'manage'
    ORDER BY a.tenant_id, a.resource_id, a.principal, a.created_at`
  const groups = new Map<string, DupRow[]>()
  for (const r of rows) {
    const k = `${r.tenant_id} ${r.resource_id} ${r.principal}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  // #536who still holds `manage` on this space. A manager wearing a weaker role too is the last
  // "one principal, two rows" stack the user sees, and the ruling settled it: keep the manager, drop the
  // weaker rows. That is not the silent demotion the manage exemption protects against — the manager
  // survives; only the redundant row goes. Row-tracked AND rowless, because the rowless one (the space
  // creator's leaf) is the production case.
  const managerRows = await admin<{ tenant_id: string; resource_id: string; principal: string }[]>`
    SELECT a.tenant_id, a.resource_id, a.principal FROM role_assignments a
    JOIN tenants t ON t.id = a.tenant_id AND t.isolation = 'logical'
    WHERE a.resource_type = 'space' AND a.builtin_capability = 'manage'`
  const managers = new Set(managerRows.map((r) => `${r.tenant_id} ${r.resource_id} ${r.principal}`))
  const holdsManage = async (key: string, spaceId: string, principal: string): Promise<boolean> => {
    if (managers.has(key)) return true
    if (!fga) return false
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so this is bounded by the type's relation count, never by tenant size.
    const { tuples } = await fga.read({ user: principal, object: `space:${spaceId}` })
    return (tuples ?? []).some((t) => t.key?.relation === 'manager')
  }

  const plan: ConvergencePlanItem[] = []
  for (const [key, g] of groups) {
    const ranked = g.filter(isRankedRow)
    const manager = ranked.length > 0 && await holdsManage(key, g[0]!.resource_id, g[0]!.principal)
    if (manager) {
      // the manager IS the keeper; every ranked row here is weaker by construction (manage rows are not
      // in this query at all), so they all go. Unranked rows stay exempt exactly as they do below.
      for (const ex of g.filter((r) => !isRankedRow(r))) {
        log(`keep (unranked capabilities, exempt like manage): ${ex.principal} on space:${ex.resource_id} — ${ex.builtin_capability ?? `role:${ex.role_id}`}`)
      }
      plan.push({
        tenantId: g[0]!.tenant_id,
        spaceId: g[0]!.resource_id,
        principal: g[0]!.principal,
        keep: 'manage',
        remove: ranked.map((r) => r.builtin_capability ?? `role:${r.role_id}`),
        keepRow: null,
        removeRows: ranked.map((r) => ({ id: r.id, label: r.builtin_capability ?? `role:${r.role_id}` })),
        managerKeeper: true,
      })
      continue
    }
    if (ranked.length < 2) continue // nothing to converge in this group (an exempt-only stack stays whole)
    // report the exempt keeps ONLY for groups that actually converge — logging every unranked role in
    // the tenant would bury the plan this dry-run exists to show (#499's discipline)
    for (const ex of g.filter((r) => !isRankedRow(r))) {
      log(`keep (unranked capabilities, exempt like manage): ${ex.principal} on space:${ex.resource_id} — ${ex.builtin_capability ?? `role:${ex.role_id}`}`)
    }
    const keep = pickKeeper(ranked)
    const removals = ranked.filter((r) => r.id !== keep.id)
    plan.push({
      tenantId: keep.tenant_id,
      spaceId: keep.resource_id,
      principal: keep.principal,
      keep: keep.builtin_capability ?? `role:${keep.role_id}`,
      remove: removals.map((r) => r.builtin_capability ?? `role:${r.role_id}`),
      keepRow: keep,
      removeRows: removals.map((r) => ({ id: r.id, label: r.builtin_capability ?? `role:${r.role_id}` })),
    })
  }
  if (fga) {
    // ROWLESS residue: a principal holding at least one MANUAL row whose FGA tuples grant a ranked,
    // non-manage capability NO row covers (the engine's COALESCE(capabilities, [builtin]) rule, over
    // rows of EVERY origin — a mapping-covered capability is not residue). Measured on the motivating
    // data: a legacy commenter tuple sitting beside an aaa-role row. `manage` never counts (the owner
    // leaf is rowless by design). Principals already planned above get their residue swept by execute
    // anyway; principals with NO manual row are never planned (their tuples may be their only access —
    // the converge-on-next-add policy stays in force for them).
    const anchored = await admin<{ tenant_id: string; resource_id: string; principal: string; caps: string[] | null; id: string; role_id: string | null; builtin_capability: string | null; capabilities: string[] | null; origin: string; created_at: Date }[]>`
      SELECT a.tenant_id, a.resource_id, a.principal, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS caps,
             a.id, a.role_id, a.builtin_capability, r.capabilities, a.origin, a.created_at
      FROM role_assignments a
      LEFT JOIN roles r ON r.id = a.role_id
      JOIN tenants t ON t.id = a.tenant_id AND t.isolation = 'logical'
      WHERE a.resource_type = 'space'
      ORDER BY a.tenant_id, a.resource_id, a.principal, a.created_at`
    const byPrincipal = new Map<string, (typeof anchored)[number][]>()
    for (const r of anchored) {
      const k = `${r.tenant_id} ${r.resource_id} ${r.principal}`
      byPrincipal.set(k, [...(byPrincipal.get(k) ?? []), r])
    }
    for (const [k, rows] of byPrincipal) {
      if (plan.some((p) => `${p.tenantId} ${p.spaceId} ${p.principal}` === k)) continue // residue rides the row plan
      const manualRows = rows.filter((r) => r.origin === 'manual')
      if (manualRows.length === 0) continue // machine-only principals are the mapping's business, not this sweep's
      const covered = new Set<string>(rows.flatMap((r) => r.caps ?? []))
      const [tenantId, spaceId, principal] = [rows[0]!.tenant_id, rows[0]!.resource_id, rows[0]!.principal]
      // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
      const { tuples } = await fga.read({ user: principal, object: `space:${spaceId}` })
      const held = new Set<string>()
      for (const t of tuples ?? []) {
        const rel = t.key?.relation ?? ''
        const cap = RELATION_TO_CAP[rel]
        if (cap && cap !== 'manage') held.add(cap)
      }
      const residue = [...held].filter((c) => Object.hasOwn(RANK, c) && !covered.has(c)).sort()
      if (residue.length === 0) continue
      // the anchor for the execute-time existence check (C): the newest MANUAL row — no row is removed
      // for a residue-only item, but a vanished anchor still means "this principal changed since the
      // plan; skip".
      const keepRow = [...manualRows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0]!
      plan.push({
        tenantId, spaceId, principal,
        keep: keepRow.builtin_capability ?? `role:${keepRow.role_id}`,
        remove: [],
        keepRow: keepRow as DupRow,
        removeRows: [],
        rowlessResidue: residue,
      })
    }
  }
  return plan
}

// Execute the plan. Removal goes through the SAME core the runtime uses (unassignRoleInTx — refcount-
// aware, tuples with rows, in-tx audit) but row by row, exactly the rows the plan named — never the
// engine's whole-principal sweep, which would also take the exempt (manage / unranked) rows the plan
// promised to keep. The rowless leftover pass then applies the engine's own covering rule against the
// SURVIVING rows. Design-review hardening: the keeper row's existence is re-checked on the tenant handle
// at execute time (a revoke racing between plan and apply must skip the group, not converge to a ghost);
// each item is isolated in try/catch and the ledger loop ALWAYS runs for whatever was actually touched.
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
  try {
    for (const p of plan) {
      const t = byTenant.get(p.tenantId)
      if (!t) { log(`tenant ${p.tenantId} not found — skipped`); continue }
      const db = await acquireTenantDb({ id: t.id, slug: t.slug, plan: t.plan, isolation: t.isolation } as Tenant)
      try {
        // the keeper must still exist NOW, on the tenant's own handle — otherwise this group would
        // converge to nothing (delete-all), which is not what anyone planned. For a MANAGER keeper the
        // standing is the tuple, not a row (#536): if their manage was revoked between plan and
        // apply, dropping the weaker rows would leave them with nothing at all.
        if (p.keepRow === null) {
          // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so this is bounded by the type's relation count, never by tenant size.
          const { tuples: keeperTuples } = await app.fga.read({ user: p.principal, object: `space:${p.spaceId}` })
          const stillManages = (keeperTuples ?? []).some((t) => t.key?.relation === 'manager')
            || (await db.sql`SELECT 1 FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${p.spaceId}
                             AND principal = ${p.principal} AND builtin_capability = 'manage'`).length > 0
          if (!stillManages) { log(`skip ${p.principal} on space:${p.spaceId}: manager standing gone since plan`); continue }
        } else {
          const keeper = await db.sql`SELECT 1 FROM role_assignments WHERE id = ${p.keepRow.id}`
          if (keeper.length === 0) { log(`skip ${p.principal} on space:${p.spaceId}: keeper row gone since plan`); continue }
        }
        let removed = 0
        for (const r of p.removeRows) {
          const exists = await db.sql`SELECT 1 FROM role_assignments WHERE id = ${r.id}`
          if (exists.length === 0) { log(`skip removal ${r.label} (${p.principal}): row gone since plan`); continue }
          await unassignRoleInTx(db, app.fga, app.searchDriver, {
            tenant: { id: p.tenantId, plan: t.plan },
            assignmentId: r.id,
            actorSub: CONVERGE_ACTOR,
            ...(r.label.startsWith('role:') ? {} : { auditAction: 'space.access_revoked' }),
          })
          removed += 1
        }
        // legacy ROWLESS leftovers: tuples no SURVIVING row covers (the engine's covering rule; manage
        // never swept — the creator leaf is indistinguishable from a legacy manager tuple)
        // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
        const { tuples } = await app.fga.read({ user: p.principal, object: `space:${p.spaceId}` })
        // #536 re-review 2: group through the EXPANSION, like the runtime sweep. RELATION_TO_CAP is a
        // display table and leaves `viewer_member` out on purpose, so grouping by it swept `viewer`
        // and left the member leaf — and `viewer: … or viewer_member` means the principal still saw
        // the space this script reported as cleaned.
        const heldRelations = new Set((tuples ?? []).map((tu) => tu.key?.relation ?? ''))
        const heldByCap = new Map<string, { user: string; relation: string; object: string }[]>()
        for (const rel of heldRelations) {
          const cap = RELATION_TO_CAP[rel]
          if (!cap) continue
          heldByCap.set(cap, spaceGrantTuplesFor(p.principal, cap, p.spaceId).filter((x: { relation: string }) => heldRelations.has(x.relation)))
        }
        let sweptRowless = false
        for (const [cap, held] of heldByCap) {
          if (cap === 'manage') continue
          const covering = await db.sql`
            SELECT 1 FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
            WHERE a.resource_type = 'space' AND a.resource_id = ${p.spaceId} AND a.principal = ${p.principal}
              AND ${cap} = ANY(COALESCE(r.capabilities, ARRAY[a.builtin_capability])) LIMIT 1`
          if (covering.length === 0) {
            // audited like every other removal this script makes ('s condition): the runtime path
            // had the same gap and it is closed in the same commit — a rowless sweep is still an authz
            // change, and the strongest one it makes is demoting a space's creator.
            await db.tx(async (tx) => {
              await auditIfEntitled(tx, { id: p.tenantId, plan: t.plan }, {
                actor: CONVERGE_ACTOR, action: 'space.access_revoked', target: `space:${p.spaceId}`,
              })
              await deleteTuples(app.fga, held)
            })
            sweptRowless = true
            removed += 1
            log(`swept rowless ${cap} tuple(s) for ${p.principal} on space:${p.spaceId}`)
          }
        }
        if (sweptRowless) await reindexPublishedPages(db, app.searchDriver, p.tenantId, p.spaceId)
        // drift visibility (informational, fail-closed): a keeper whose expansion tuples are missing
        // is legacy row/tuple skew — writing tuples is an authz change this script must NOT make, so
        // it is reported for a human to look at instead.
        const keepCaps = p.keepRow === null
          ? ['manage'] // the manager keeper: its leaf is the one that must still be there
          : p.keepRow.builtin_capability != null ? [p.keepRow.builtin_capability] : (p.keepRow.capabilities ?? [])
        for (const cap of keepCaps) {
          if (!heldByCap.has(cap)) log(`WARNING: keeper of ${p.principal} on space:${p.spaceId} holds no '${cap}' tuple (legacy row/tuple drift — not repaired here)`)
        }
        if (removed > 0) touched.set(p.tenantId, (touched.get(p.tenantId) ?? 0) + removed)
        log(`converged ${p.principal} on space:${p.spaceId} → kept ${p.keep}, removed ${p.remove.join(', ') || '(rowless only)'}`)
      } catch (e) {
        log(`ERROR converging ${p.principal} on space:${p.spaceId}: ${e instanceof Error ? e.message : String(e)} — continuing`)
      } finally {
        await db.release()
      }
    }
  } finally {
    // one operator-ledger entry per touched tenant — written even when a later item failed, so what
    // actually happened is on the record (ADR-089: no unrecorded privilege use)
    for (const [tenantId, removed] of touched) {
      await admin.begin(async (tx) => {
        await appendOperatorEntry(tx, {
          actor: CONVERGE_ACTOR,
          action: 'roles.duplicates_converged',
          target: `tenant:${tenantId}`,
          at: new Date().toISOString(),
          reason: 'maintenance',
        })
      })
      log(`ledger: tenant:${tenantId} — ${removed} duplicate assignment(s)/tuple set(s) removed`)
    }
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const APPLY = process.argv.includes('--apply')
  ;(async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL
    if (!adminUrl) { console.error('DATABASE_ADMIN_URL required'); process.exit(1) }
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
    // a bare FGA client for the plan's rowless-residue reads (read-only; same envs the server uses)
    const { OpenFgaClient } = await import('@openfga/sdk')
    const fga = new OpenFgaClient({
      apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
      storeId: process.env.OPENFGA_STORE_ID!,
      ...(process.env.OPENFGA_MODEL_ID ? { authorizationModelId: process.env.OPENFGA_MODEL_ID } : {}),
    })
    const plan = await planConvergence(admin, console.log, fga)
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${plan.length} principal(s) with duplicate/residual manual space roles`)
    for (const p of plan) console.log(JSON.stringify({ tenantId: p.tenantId, spaceId: p.spaceId, principal: p.principal, keep: p.keep, remove: p.remove, ...(p.rowlessResidue ? { rowlessResidue: p.rowlessResidue } : {}) }))
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
