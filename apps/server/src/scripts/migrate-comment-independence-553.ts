// #553 / ADR-199 §3 (T2): passes 1–2 of the comment-independence migration — rows first, residual
// tuples second. The MODEL SWAP (§1) is deliberately NOT here: it lands last (T3), after every
// current edit holder has an explicit comment grant, so nobody loses comment in the gap.
//
//   Pass 1a — every existing BUILT-IN `edit` row (space AND page scope) gains a SIBLING built-in
//     `comment` row. Not through grantSpaceAccess/grantPageAccess (those need an acting principal and
//     emit per-grant webhooks — a migration is not user activity): the assign tx core is called
//     directly, webhook-free, with PRE-READ ownership — the migration row claims the comment leaf
//     ONLY if the leaf was absent at write time. the unconditional built-in ownership is for
//     user-initiated grants; a pre-existing rowless commenter tuple may be a deliberate legacy grant,
//     and a migration row that claimed it would let a later revoke of the auto-created row delete an
//     administrator's intentional grant. (The opt-out is structural: this script computes `owned`
//     itself and never sets the builtin-unconditional override.)
//   Pass 1b — every role whose capabilities include `edit` but not `comment` gains `comment` in its
//     DEFINITION, propagated to live assignments WITH ownership rows (owned_capabilities appends
//     `comment` only where the assignment claimed the leaf — a tuples-only shortcut creates
//     unrevocable residue).
//   Pass 2 — rowless legacy `edit` leaf holders (user/group subjects ONLY — share_link is excluded:
//     comment_direct/commenter do not admit it, and its fate was ruled in §5(i), the model arm) get
//     the paired comment leaf as rowless tuples. Idempotent, exact-match guarded.
//
// Dry-run is the DEFAULT (--apply executes). LOGICAL-isolation tenants only (the converge-536 D rule:
// this planner reads public through the admin connection; a namespace tenant's public rows are a
// frozen rollback copy). One operator-ledger entry records the whole pass (reason 'maintenance');
// per-row audit/webhooks are deliberately silent. No search reindex: the viewer set is unchanged
// (doc-builder indexes edit and comment leaves already — ADR-199 §4).
import postgres from 'postgres'
import { pathToFileURL } from 'node:url'
import type { OpenFgaClient } from '@openfga/sdk'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { writeTuples, readObjectTuples, FGA_WRITE_CHUNK } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { acquireTenantDb, withTenantTx } from '../db/index.js'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import type { Tenant } from '@wikistead/types'

export const MIGRATE_ACTOR = 'operator:migrate-553'

// the comment leaf per scope — mirrors expansionTuples('comment') (roles.ts PAGE_CAP_RELATION /
// the shared space table); inlined names, pinned by the tests against the real expansion
const COMMENT_LEAF: Record<'page' | 'space', string> = { page: 'comment_direct', space: 'commenter' }
const EDIT_LEAVES: Record<'page' | 'space', string[]> = { page: ['edit_direct'], space: ['editor', 'editor_member'] }

export interface CommentIndependencePlan {
  siblingRows: { tenantId: string; resourceType: 'page' | 'space'; resourceId: string; principal: string }[]
  roleDefs: { tenantId: string; roleId: string; name: string }[]
  roleAssignments: { tenantId: string; assignmentId: string; resourceType: 'page' | 'space'; resourceId: string; principal: string }[]
  rowlessPairs: { tenantId: string; resourceType: 'page' | 'space'; resourceId: string; principal: string }[]
}

export async function planCommentIndependence(
  admin: postgres.Sql,
  fga: OpenFgaClient,
  log: (line: string) => void = console.log,
): Promise<CommentIndependencePlan> {
  const skipped = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE isolation <> 'logical'`
  for (const t of skipped) log(`skip tenant ${t.id}: namespace-isolated`)

  // 1a: built-in edit rows with no sibling comment row
  const siblingRows = (await admin<{ tenant_id: string; resource_type: 'page' | 'space'; resource_id: string; principal: string }[]>`
    SELECT a.tenant_id, a.resource_type, a.resource_id, a.principal
    FROM role_assignments a JOIN tenants t ON t.id = a.tenant_id AND t.isolation = 'logical'
    WHERE a.builtin_capability = 'edit' AND a.resource_type IN ('page', 'space')
      AND NOT EXISTS (
        SELECT 1 FROM role_assignments s
        WHERE s.builtin_capability = 'comment' AND s.resource_type = a.resource_type
          AND s.resource_id = a.resource_id AND s.principal = a.principal)`)
    .map((r) => ({ tenantId: r.tenant_id, resourceType: r.resource_type, resourceId: r.resource_id, principal: r.principal }))

  // 1b: roles with edit but not comment, and their live resource-scope assignments
  const roleDefs = (await admin<{ tenant_id: string; id: string; name: string }[]>`
    SELECT r.tenant_id, r.id, r.name FROM roles r JOIN tenants t ON t.id = r.tenant_id AND t.isolation = 'logical'
    WHERE 'edit' = ANY(r.capabilities) AND NOT ('comment' = ANY(r.capabilities))`)
    .map((r) => ({ tenantId: r.tenant_id, roleId: r.id, name: r.name }))
  const roleIds = roleDefs.map((r) => r.roleId)
  const roleAssignments = roleIds.length
    ? (await admin<{ tenant_id: string; id: string; resource_type: 'page' | 'space'; resource_id: string; principal: string }[]>`
        SELECT tenant_id, id, resource_type, resource_id, principal FROM role_assignments
        WHERE role_id = ANY(${roleIds}) AND resource_type IN ('page', 'space')`)
      .map((r) => ({ tenantId: r.tenant_id, assignmentId: r.id, resourceType: r.resource_type, resourceId: r.resource_id, principal: r.principal }))
    : []

  // 2: rowless edit-leaf holders with no covering row and no comment leaf. Resources enumerated from
  // the DB (spaces + pages of logical tenants); tuples read per resource.
  const rowlessPairs: CommentIndependencePlan['rowlessPairs'] = []
  const resources: { tenantId: string; resourceType: 'page' | 'space'; resourceId: string }[] = []
  for (const s of await admin<{ tenant_id: string; id: string }[]>`
      SELECT s.tenant_id, s.id FROM spaces s JOIN tenants t ON t.id = s.tenant_id AND t.isolation = 'logical'`) {
    resources.push({ tenantId: s.tenant_id, resourceType: 'space', resourceId: s.id })
  }
  for (const p of await admin<{ tenant_id: string; id: string }[]>`
      SELECT p.tenant_id, p.id FROM pages p JOIN tenants t ON t.id = p.tenant_id AND t.isolation = 'logical'`) {
    resources.push({ tenantId: p.tenant_id, resourceType: 'page', resourceId: p.id })
  }
  // a pair is excluded only when PASS 1 ITSELF will write its leaf — not when a covering row merely
  // exists (#553 review G: a row whose leaf died through another revoke satisfies "row exists" while
  // pass 1a's NOT EXISTS skips it, and the pair would silently lose comment at the swap; converging
  // the leaf to the row it matches is the fail-closed direction)
  const pass1Covered = new Set<string>([
    ...siblingRows.map((r) => `${r.resourceType}:${r.resourceId}|${r.principal}`),
    ...roleAssignments.map((r) => `${r.resourceType}:${r.resourceId}|${r.principal}`),
  ])
  for (const res of resources) {
    // paginated to completion — a bare fga.read answers ONE page (50) and silently truncates, which
    // on a real-sized space (~17 members) drops edit holders from the plan (#553 review A)
    const rel = await readObjectTuples(fga, `${res.resourceType}:${res.resourceId}`)
    const commentHolders = new Set(rel.filter((k) => k.relation === COMMENT_LEAF[res.resourceType]).map((k) => k.user))
    const editHolders = [...new Set(rel.filter((k) => EDIT_LEAVES[res.resourceType].includes(k.relation)).map((k) => k.user))]
    for (const user of editHolders) {
      if (user.startsWith('share_link:')) continue // §5: comment leaves do not admit share_link — ruled, excluded
      if (!/^user:[^*\s]+$/.test(user) && !/^group:[^\s]+#member$/.test(user)) continue
      if (commentHolders.has(user)) continue
      if (pass1Covered.has(`${res.resourceType}:${res.resourceId}|${user}`)) continue
      rowlessPairs.push({ tenantId: res.tenantId, resourceType: res.resourceType, resourceId: res.resourceId, principal: user })
    }
  }
  return { siblingRows, roleDefs, roleAssignments, rowlessPairs }
}

export async function executeCommentIndependence(
  admin: postgres.Sql,
  app: FastifyInstance,
  plan: CommentIndependencePlan,
  log: (line: string) => void = console.log,
): Promise<void> {
  const tenants = new Map((await admin<{ id: string; slug: string; plan: string; isolation: string }[]>`SELECT id, slug, plan, isolation FROM tenants`).map((t) => [t.id, t]))
  const tenantOf = (id: string): Tenant => {
    const t = tenants.get(id)
    if (!t) throw new Error(`tenant ${id} vanished mid-migration`)
    return { id: t.id, slug: t.slug, plan: t.plan, isolation: t.isolation } as Tenant
  }

  // pass 1a: sibling comment rows with PRE-READ ownership, webhook- and audit-silent
  for (const r of plan.siblingRows) {
    const leaf = COMMENT_LEAF[r.resourceType]
    const object = `${r.resourceType}:${r.resourceId}`
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
    const { tuples } = await app.fga.read({ user: r.principal, object })
    const present = (tuples ?? []).some((t) => t.key?.relation === leaf)
    const db = await acquireTenantDb(tenantOf(r.tenantId))
    try {
      await db.tx(async (tx) => {
        const dup = await tx<{ id: string }[]>`
          SELECT id FROM role_assignments WHERE builtin_capability = 'comment' AND resource_type = ${r.resourceType} AND resource_id = ${r.resourceId} AND principal = ${r.principal}`
        if (dup.length) return // idempotent
        await tx`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
                 VALUES (${randomUUID()}, ${r.tenantId}, NULL, 'comment', ${r.resourceType}, ${r.resourceId}, ${r.principal}, ${present ? [] : ['comment']}, 'manual')`
        if (!present) await writeTuples(app.fga, [{ user: r.principal, relation: leaf, object }])
      })
      log(`1a: sibling comment row for ${r.principal} on ${object}${present ? ' (leaf pre-existed — not claimed)' : ''}`)
    } finally {
      await db.release()
    }
  }

  // pass 1b: role definitions gain comment; live assignments claim the leaf where absent
  for (const d of plan.roleDefs) {
    await withTenantTx(tenantOf(d.tenantId), async (tx) => {
      await tx`UPDATE roles SET capabilities = array_append(capabilities, 'comment') WHERE id = ${d.roleId} AND NOT ('comment' = ANY(capabilities))`
    })
    log(`1b: role ${d.name} (${d.roleId}) gains comment in its definition`)
  }
  for (const a of plan.roleAssignments) {
    const leaf = COMMENT_LEAF[a.resourceType]
    const object = `${a.resourceType}:${a.resourceId}`
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
    const { tuples } = await app.fga.read({ user: a.principal, object })
    const present = (tuples ?? []).some((t) => t.key?.relation === leaf)
    await withTenantTx(tenantOf(a.tenantId), async (tx) => {
      if (!present) {
        await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, 'comment') WHERE id = ${a.assignmentId} AND NOT ('comment' = ANY(owned_capabilities))`
      }
    })
    if (!present) await writeTuples(app.fga, [{ user: a.principal, relation: leaf, object }])
    log(`1b: assignment ${a.assignmentId} ${present ? 'leaf pre-existed — not claimed' : 'claims the comment leaf'}`)
  }

  // pass 2: rowless pairs (share_link already excluded by the plan)
  const toWrite = plan.rowlessPairs.map((r) => ({ user: r.principal, relation: COMMENT_LEAF[r.resourceType], object: `${r.resourceType}:${r.resourceId}` }))
  // chunked: one fga.write refuses batches above max_tuples_per_write (default 100) and a real
  // tenant clears that easily (#553 review B)
  for (let i = 0; i < toWrite.length; i += FGA_WRITE_CHUNK) {
    await writeTuples(app.fga, toWrite.slice(i, i + FGA_WRITE_CHUNK))
  }
  // #553 re-review G2: when the pair has a visible comment ROW whose leaf died (the dead-leaf
  // convergence case), the row must OWN the leaf this pass just wrote — a row with empty
  // owned_capabilities revokes nothing (roles.ts builds deletes from owned only), which would be
  // exactly the unrevocable tuples-only residue pass 1b's discipline forbids.
  for (const r of plan.rowlessPairs) {
    await withTenantTx(tenantOf(r.tenantId), async (tx) => {
      await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, 'comment')
        WHERE resource_type = ${r.resourceType} AND resource_id = ${r.resourceId} AND principal = ${r.principal}
          AND builtin_capability = 'comment' AND NOT ('comment' = ANY(owned_capabilities))`
    })
  }
  for (const w of toWrite) log(`2: rowless comment leaf for ${w.user} on ${w.object}`)

  // one ledger entry for the whole pass — a migration is not user activity (no webhooks, no per-row audit)
  await admin.begin(async (tx) => {
    await appendOperatorEntry(tx, {
      actor: MIGRATE_ACTOR,
      action: 'authz.comment_independence_backfilled',
      target: '',
      at: new Date().toISOString(),
      reason: 'maintenance',
    })
  })
  log(`ledger: ${plan.siblingRows.length} sibling row(s), ${plan.roleDefs.length} role def(s), ${plan.roleAssignments.length} assignment(s), ${plan.rowlessPairs.length} rowless pair(s)`)
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const APPLY = process.argv.includes('--apply')
  ;(async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL
    if (!adminUrl) { console.error('DATABASE_ADMIN_URL required'); process.exit(1) }
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
    const { OpenFgaClient } = await import('@openfga/sdk')
    const fga = new OpenFgaClient({
      apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
      storeId: process.env.OPENFGA_STORE_ID!,
      ...(process.env.OPENFGA_MODEL_ID ? { authorizationModelId: process.env.OPENFGA_MODEL_ID } : {}),
    })
    const plan = await planCommentIndependence(admin, fga)
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: 1a=${plan.siblingRows.length} 1b-defs=${plan.roleDefs.length} 1b-assignments=${plan.roleAssignments.length} 2-rowless=${plan.rowlessPairs.length}`)
    for (const r of plan.siblingRows) console.log(JSON.stringify({ pass: '1a', ...r }))
    for (const r of plan.roleDefs) console.log(JSON.stringify({ pass: '1b-def', ...r }))
    for (const r of plan.rowlessPairs) console.log(JSON.stringify({ pass: '2', ...r }))
    if (!APPLY) { await admin.end(); process.exit(0) }
    const app = await buildApp()
    await app.ready()
    await executeCommentIndependence(admin, app, plan)
    await app.close()
    await admin.end()
    console.log('comment-independence backfill complete (the model swap is T3 — run it only after this)')
    process.exit(0)
  })().catch((e) => { console.error(e); process.exit(1) })
}
