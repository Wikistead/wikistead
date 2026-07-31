// #553 / ADR-199 §3 (T2): migration passes 1–2 on simulated pre-swap state. The anti-tests:
//   - pass-1 ownership BOTH ways: revoking the auto-created comment row removes the leaf it created;
//     a PRE-EXISTING rowless commenter tuple is NOT claimed (revoking the migration row leaves the
//     legacy grant alive) — the pre-read rule, not's unconditional one;
//   - pass-1b: an edit-carrying custom role gains comment in its definition AND its live assignment
//     claims the leaf (ownership rows, not tuples-only residue);
//   - pass-2: a rowless legacy edit holder gets the paired comment leaf; share_link subjects are
//     untouched; dry-run (the plan) writes nothing; the whole run is idempotent; one ledger entry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { planCommentIndependence, executeCommentIndependence } from '../scripts/migrate-comment-independence-553.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const P_ROW = `user:mc-row-${STAMP}`     // builtin edit row → sibling comment row (leaf claimed)
const P_LEGACY = `user:mc-leg-${STAMP}`  // builtin edit row + PRE-EXISTING rowless commenter tuple
const P_ROLE = `user:mc-role-${STAMP}`   // edit-carrying custom role assignment
const P_ROWLESS = `user:mc-nolr-${STAMP}` // rowless editor_member tuple, no row
const SL = `share_link:mc-sl-${STAMP}`   // share_link edit tuple — must stay untouched

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `mc-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `mc-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })

  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: P_ROW, capability: 'edit', plan: 'business' })
  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: P_LEGACY, capability: 'edit', plan: 'business' })
  // the deliberate legacy comment grant the migration must NOT claim
  await writeTuples(fgaClient, [{ user: P_LEGACY, relation: 'commenter', object: `space:${spaceId}` }])

  roleId = `mc-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`mc-${STAMP}`}, ARRAY['view','edit']::text[], 'resource')`
  await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, owned_capabilities, origin)
    VALUES (${randomUUID()}, ${TENANT}, ${roleId}, 'space', ${spaceId}, ${P_ROLE}, ARRAY['view','edit']::text[], 'manual')`
  await writeTuples(fgaClient, [
    { user: P_ROLE, relation: 'viewer', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'viewer_member', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'editor_member', object: `space:${spaceId}` },
  ])

  await writeTuples(fgaClient, [
    { user: P_ROWLESS, relation: 'editor_member', object: `space:${spaceId}` },
    { user: SL, relation: 'edit_direct', object: `page:${pageId}` },
  ])
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id IN (${spaceId}, ${pageId})`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM operator_audit_log WHERE actor = 'operator:migrate-553'`.catch(() => {})
  await deleteTuples(fgaClient, [
    { user: P_LEGACY, relation: 'commenter', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'viewer', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'viewer_member', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'editor_member', object: `space:${spaceId}` },
    { user: P_ROLE, relation: 'commenter', object: `space:${spaceId}` },
    { user: P_ROWLESS, relation: 'editor_member', object: `space:${spaceId}` },
    { user: P_ROWLESS, relation: 'commenter', object: `space:${spaceId}` },
    { user: SL, relation: 'edit_direct', object: `page:${pageId}` },
  ]).catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const rowsOf = (principal: string) => adminPool<{ id: string; builtin_capability: string | null; owned_capabilities: string[] }[]>`
  SELECT id, builtin_capability, owned_capabilities FROM role_assignments
  WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability`
const relationsOf = async (principal: string, object: string) => {
  const { tuples } = await fgaClient.read({ user: principal, object })
  return (tuples ?? []).map((t) => t.key?.relation).sort()
}

describe('#553 T2: comment-independence migration, passes 1–2', () => {
  it('plans without writing, applies both ways of ownership, backfills roles and rowless holders, once', async () => {
    const plan = await planCommentIndependence(adminPool, fgaClient, () => {})
    const mine = (p: { principal?: string }) => [P_ROW, P_LEGACY, P_ROLE, P_ROWLESS].includes(p.principal ?? '')
    expect(plan.siblingRows.filter(mine).map((r) => r.principal).sort()).toEqual([P_LEGACY, P_ROW].sort())
    expect(plan.roleDefs.some((d) => d.roleId === roleId), 'the edit-carrying role is planned').toBe(true)
    expect(plan.rowlessPairs.filter(mine).map((r) => r.principal)).toEqual([P_ROWLESS])
    expect(plan.rowlessPairs.some((r) => r.principal.startsWith('share_link:')), 'share_link never planned').toBe(false)
    // dry-run (the plan) wrote nothing
    expect((await rowsOf(P_ROW)).map((r) => r.builtin_capability)).toEqual(['edit'])

    await executeCommentIndependence(adminPool, app, plan, () => {})

    // idempotent FIRST (before the ownership checks below revoke rows and legitimately re-open plans):
    // a re-plan straight after the run finds nothing left for these principals
    const replan = await planCommentIndependence(adminPool, fgaClient, () => {})
    expect(replan.siblingRows.filter(mine)).toEqual([])
    expect(replan.roleDefs.some((d) => d.roleId === roleId)).toBe(false)
    expect(replan.rowlessPairs.filter(mine)).toEqual([])

    // 1a claimed: the sibling row owns the leaf it created; revoking it removes the leaf
    const rowRows = await rowsOf(P_ROW)
    expect(rowRows.map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
    expect(rowRows.find((r) => r.builtin_capability === 'comment')!.owned_capabilities).toEqual(['comment'])
    expect(await check(fgaClient, P_ROW, 'comment', { type: 'page', id: pageId })).toBe(true)
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: P_ROW, capability: 'comment', plan: 'business' })
    expect(await relationsOf(P_ROW, `space:${spaceId}`), 'the claimed leaf died with its row').not.toContain('commenter')

    // 1a pre-read: the legacy tuple was NOT claimed — revoking the migration row leaves it alive
    const legRows = await rowsOf(P_LEGACY)
    expect(legRows.find((r) => r.builtin_capability === 'comment')!.owned_capabilities, 'pre-existing leaf → not claimed').toEqual([])
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: P_LEGACY, capability: 'comment', plan: 'business' })
    expect(await relationsOf(P_LEGACY, `space:${spaceId}`), 'the deliberate legacy grant survives').toContain('commenter')

    // 1b: the role definition and its live assignment
    const [role] = await adminPool<{ capabilities: string[] }[]>`SELECT capabilities FROM roles WHERE id = ${roleId}`
    expect(role!.capabilities).toContain('comment')
    const [asg] = await adminPool<{ owned_capabilities: string[] }[]>`
      SELECT owned_capabilities FROM role_assignments WHERE role_id = ${roleId} AND principal = ${P_ROLE}`
    expect(asg!.owned_capabilities, 'the assignment claims what it wrote').toContain('comment')
    expect(await check(fgaClient, P_ROLE, 'comment', { type: 'page', id: pageId })).toBe(true)

    // 2: rowless pair written; share_link untouched
    expect(await relationsOf(P_ROWLESS, `space:${spaceId}`)).toContain('commenter')
    expect(await relationsOf(SL, `page:${pageId}`), 'share_link untouched').toEqual(['edit_direct'])

    // ledger recorded once for the pass
    const ledger = await adminPool<{ action: string }[]>`
      SELECT action FROM operator_audit_log WHERE actor = 'operator:migrate-553'`
    expect(ledger.length).toBe(1)
  }, 240_000)
})

// #553 review A/G: the plan must see past OpenFGA Read's silent one-page (50) truncation, and a
// pair whose covering row exists but whose leaf died must still be planned (converge to the row).
describe('#553 T2 review fixes: pagination and the dead-leaf covering row', () => {
  it('plans EVERY edit holder on a resource with more tuples than one Read page — and never writes', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ user: `user:mc-pg${i}-${STAMP}`, relation: 'edit_direct', object: `page:${pageId}` }))
    await writeTuples(fgaClient, many)
    try {
      // the plan is the dry run: any FGA write during planning is a bug (ADR-199 §3 anti-test)
      const readOnly = new Proxy(fgaClient, {
        get: (t, p) => (p === 'write' ? () => { throw new Error('plan must not write') } : (t as never as Record<PropertyKey, unknown>)[p]),
      })
      const plan = await planCommentIndependence(adminPool, readOnly as typeof fgaClient, () => {})
      const planned = new Set(plan.rowlessPairs.filter((r) => r.resourceId === pageId).map((r) => r.principal))
      for (const m of many) expect(planned.has(m.user), `${m.user} survives pagination`).toBe(true)
    } finally {
      await deleteTuples(fgaClient, many).catch(() => {})
    }
  }, 240_000)

  it('a covering edit row whose comment leaf died elsewhere is re-planned, not skipped (review G)', async () => {
    const p = `user:mc-dead-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    // simulate the G state: a sibling comment ROW exists (so pass 1a's NOT EXISTS skips the pair)
    // while its leaf is gone (revoked through another path)
    await adminPool`INSERT INTO role_assignments (id, tenant_id, resource_type, resource_id, principal, builtin_capability, owned_capabilities, origin)
      VALUES (${randomUUID()}, ${TENANT}, 'space', ${spaceId}, ${p}, 'comment', ARRAY[]::text[], 'manual')`
    try {
      const plan = await planCommentIndependence(adminPool, fgaClient, () => {})
      expect(plan.siblingRows.some((r) => r.principal === p), 'row pair complete — 1a correctly skips').toBe(false)
      expect(plan.rowlessPairs.some((r) => r.resourceId === spaceId && r.principal === p),
        'the dead leaf converges back to its row instead of silently losing comment at the swap').toBe(true)

      // #553 re-review G2: after APPLY, the visible comment row must OWN the leaf the migration wrote
      // — an owned={} row revokes nothing (deletes are built from owned_capabilities only), which
      // would be exactly the unrevocable tuples-only residue this script's own 1b rule forbids.
      await executeCommentIndependence(adminPool, app, {
        siblingRows: [], roleDefs: [], roleAssignments: [],
        rowlessPairs: plan.rowlessPairs.filter((r) => r.principal === p),
      }, () => {})
      expect(await relationsOf(p, `space:${spaceId}`)).toContain('commenter')
      const [row] = await adminPool<{ owned_capabilities: string[] }[]>`
        SELECT owned_capabilities FROM role_assignments
        WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${p} AND builtin_capability = 'comment'`
      expect(row!.owned_capabilities, 'the row claims the migration-written leaf').toEqual(['comment'])
      await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'comment', plan: 'business' })
      expect(await relationsOf(p, `space:${spaceId}`), 'revoking the row kills the leaf — no residue').not.toContain('commenter')
    } finally {
      await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
      await deleteTuples(fgaClient, [{ user: p, relation: 'editor', object: `space:${spaceId}` }]).catch(() => {})
    }
  }, 240_000)
})
