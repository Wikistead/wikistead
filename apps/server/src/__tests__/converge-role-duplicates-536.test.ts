// #536 (5): the one-shot convergence of pre-existing duplicate space-role assignments.
// Simulated legacy state (rows + tuples inserted directly, bypassing the runtime replace) converges to
// the strongest role — rows AND FGA tuples together — while `manage` and mapping-owned rows survive
// untouched, and the run leaves an operator-ledger entry. Dry-run (planConvergence) is read-only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, listSpaceAccess } from '../routes/spaces.js'
import { buildApp } from '../app.js'
import { planConvergence, executeConvergence, pickKeeper, isRankedRow, type DupRow } from '../scripts/converge-role-duplicates-536.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let roleId = ''
let pubRoleId = ''
let covRoleId = ''
const P_DUP = `user:cvg-dup-${STAMP}`
const P_MGR = `user:cvg-mgr-${STAMP}`
const P_MAP = `user:cvg-map-${STAMP}`
const P_PUB = `user:cvg-pub-${STAMP}`  // carries an UNRANKED (publish) role next to a ranked pair
const P_MIX = `user:cvg-mix-${STAMP}`  // one manual row next to mapping rows — not a duplicate group
const P_RES = `user:cvg-res-${STAMP}`  // ONE custom-role row + a legacy ROWLESS commenter tuple (the dev shape)
const P_COV = `user:cvg-cov-${STAMP}`  // an EXEMPT role sharing a ranked cap with a removed builtin row

const insertRow = (principal: string, opts: { builtin?: string; roleId?: string; origin?: string; caps: string[]; at?: string }) =>
  adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin, created_at)
    VALUES (${randomUUID()}, ${TENANT}, ${opts.roleId ?? null}, ${opts.builtin ?? null}, 'space', ${spaceId}, ${principal}, ${opts.caps}, ${opts.origin ?? 'manual'}, ${opts.at ?? new Date().toISOString()})`

const tuplesFor = (principal: string, rels: string[]) =>
  rels.map((relation) => ({ user: principal, relation, object: `space:${spaceId}` }))

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `cvg-${STAMP}` })).id
  roleId = `cvg-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`cvg-${STAMP}`}, ARRAY['view','edit']::text[], 'resource')`

  // the legacy stack (the demo_space shape): builtin view + builtin comment + the custom role (view+edit)
  await insertRow(P_DUP, { builtin: 'view', caps: ['view'], at: '2026-01-01T00:00:00Z' })
  await insertRow(P_DUP, { builtin: 'comment', caps: ['comment'], at: '2026-01-02T00:00:00Z' })
  await insertRow(P_DUP, { roleId, caps: ['view', 'edit'], at: '2026-01-03T00:00:00Z' })
  await writeTuples(fgaClient, tuplesFor(P_DUP, ['viewer', 'viewer_member', 'commenter', 'editor_member']))

  // a manager next to a duplicate pair: the manage row must survive while view/comment converge
  await insertRow(P_MGR, { builtin: 'manage', caps: ['manage'], at: '2026-01-01T00:00:00Z' })
  await insertRow(P_MGR, { builtin: 'view', caps: ['view'], at: '2026-01-02T00:00:00Z' })
  await insertRow(P_MGR, { builtin: 'comment', caps: ['comment'], at: '2026-01-03T00:00:00Z' })
  await writeTuples(fgaClient, tuplesFor(P_MGR, ['manager', 'viewer', 'viewer_member', 'commenter']))

  // mapping-owned rows are machine state — never converged, even in duplicate shape
  await insertRow(P_MAP, { builtin: 'view', origin: 'mapping', caps: ['view'] })
  await insertRow(P_MAP, { builtin: 'comment', origin: 'mapping', caps: ['comment'] })
  await writeTuples(fgaClient, tuplesFor(P_MAP, ['viewer', 'viewer_member', 'commenter']))

  // an UNRANKED custom role (publish) next to a ranked view/comment pair: the publish role is exempt
  // (kept), the ranked pair still converges. Plus a stray legacy ROWLESS moderator tuple that no row
  // covers — the leftover pass must take it (manage-shaped tuples would not be).
  pubRoleId = `cvg-pub-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${pubRoleId}, ${TENANT}, ${`cvg-pub-${STAMP}`}, ARRAY['publish']::text[], 'resource')`
  await insertRow(P_PUB, { roleId: pubRoleId, caps: ['publish'], at: '2026-01-01T00:00:00Z' })
  await insertRow(P_PUB, { builtin: 'view', caps: ['view'], at: '2026-01-02T00:00:00Z' })
  await insertRow(P_PUB, { builtin: 'comment', caps: ['comment'], at: '2026-01-03T00:00:00Z' })
  await writeTuples(fgaClient, tuplesFor(P_PUB, ['publisher', 'viewer', 'viewer_member', 'commenter', 'moderator']))

  // ONE manual row next to mapping rows is not a duplicate group — nothing to converge
  await insertRow(P_MIX, { builtin: 'view', origin: 'mapping', caps: ['view'] })
  await insertRow(P_MIX, { builtin: 'edit', caps: ['edit'] })
  await writeTuples(fgaClient, tuplesFor(P_MIX, ['viewer', 'viewer_member', 'editor_member']))

  // the MOTIVATING dev shape: one custom-role row (its expansion tuples) + a legacy ROWLESS commenter
  // tuple no row covers — no row duplicate, but a rowless residue the fga-aware plan must catch
  await insertRow(P_RES, { roleId, caps: ['view', 'edit'], at: '2026-01-01T00:00:00Z' })
  await writeTuples(fgaClient, tuplesFor(P_RES, ['viewer', 'viewer_member', 'editor_member', 'commenter']))

  // covering across the exemption boundary: an EXEMPT role that also owns `view` sits beside a builtin
  // view/edit duplicate pair. The view row is removed (edit wins) — but the viewer tuple must SURVIVE,
  // because the exempt row still owns view (refcount + covering, the reviewer's unpinned case).
  covRoleId = `cvg-cov-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${covRoleId}, ${TENANT}, ${`cvg-cov-${STAMP}`}, ARRAY['view','publish']::text[], 'resource')`
  await insertRow(P_COV, { roleId: covRoleId, caps: ['view', 'publish'], at: '2026-01-01T00:00:00Z' })
  await insertRow(P_COV, { builtin: 'view', caps: ['view'], at: '2026-01-02T00:00:00Z' })
  await insertRow(P_COV, { builtin: 'edit', caps: ['edit'], at: '2026-01-03T00:00:00Z' })
  await writeTuples(fgaClient, tuplesFor(P_COV, ['viewer', 'viewer_member', 'publisher', 'editor_member']))
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${pubRoleId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${covRoleId}`.catch(() => {})
  await deleteTuples(fgaClient, tuplesFor(P_COV, ['viewer', 'viewer_member', 'publisher'])).catch(() => {})
  await adminPool`DELETE FROM tenant_transparency_log WHERE tenant_id = ${TENANT} AND action = 'roles.duplicates_converged'`.catch(() => {})
  await deleteTuples(fgaClient, tuplesFor(P_MIX, ['viewer', 'viewer_member', 'editor_member'])).catch(() => {})
  await deleteTuples(fgaClient, tuplesFor(P_PUB, ['publisher'])).catch(() => {})
  await adminPool`DELETE FROM operator_audit_log WHERE actor = 'operator:converge-536'`.catch(() => {})
  await deleteTuples(fgaClient, tuplesFor(P_MAP, ['viewer', 'viewer_member', 'commenter'])).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const rowsOf = (principal: string) => adminPool<{ role_id: string | null; builtin_capability: string | null; origin: string }[]>`
  SELECT role_id, builtin_capability, origin FROM role_assignments
  WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability NULLS FIRST`
const relationsOf = async (principal: string) => {
  const { tuples } = await fgaClient.read({ user: principal, object: `space:${spaceId}` })
  return (tuples ?? []).map((t) => t.key?.relation).sort()
}

describe('#536 (5): one-shot duplicate convergence', () => {
  it('keeper rule: strongest wins; custom beats built-in on a tie; newest on a full tie', () => {
    const mk = (o: Partial<DupRow>): DupRow => ({
      id: randomUUID(), tenant_id: 't', resource_id: 's', principal: 'p',
      role_id: null, builtin_capability: null, capabilities: null, created_at: new Date('2026-01-01'), ...o,
    })
    expect(pickKeeper([mk({ builtin_capability: 'view' }), mk({ builtin_capability: 'edit' })]).builtin_capability).toBe('edit')
    expect(pickKeeper([mk({ builtin_capability: 'edit' }), mk({ role_id: 'r', capabilities: ['view', 'edit'] })]).role_id).toBe('r')
    expect(pickKeeper([
      mk({ builtin_capability: 'view', created_at: new Date('2026-01-01') }),
      mk({ builtin_capability: 'comment', created_at: new Date('2026-01-02') }),
    ]).builtin_capability).toBe('comment')
  })

  it('unranked capabilities are exempt from the rank order (design-review A)', () => {
    expect(isRankedRow({ builtin_capability: 'view', capabilities: null })).toBe(true)
    expect(isRankedRow({ builtin_capability: null, capabilities: ['view', 'edit'] })).toBe(true)
    expect(isRankedRow({ builtin_capability: null, capabilities: ['publish'] })).toBe(false)
    expect(isRankedRow({ builtin_capability: null, capabilities: ['edit', 'share'] })).toBe(false)
    expect(isRankedRow({ builtin_capability: null, capabilities: [] })).toBe(false)
  })

  it('dry-run plans without writing; apply converges rows AND tuples; manage/mapping/unranked survive; ledger written', async () => {
    const plan = await planConvergence(adminPool, () => {})
    const dup = plan.find((p) => p.principal === P_DUP)
    const mgr = plan.find((p) => p.principal === P_MGR)
    const pub = plan.find((p) => p.principal === P_PUB)
    expect(dup, 'the stacked principal is planned').toBeTruthy()
    expect(dup!.keep, 'the custom role (view+edit) is the strongest keeper').toBe(`role:${roleId}`)
    expect(dup!.remove.sort()).toEqual(['comment', 'view'])
    expect(mgr, 'the manager duplicate pair is planned (manage itself excluded)').toBeTruthy()
    expect(mgr!.keep).toBe('comment')
    expect(mgr!.remove, 'manage is NEVER in a removal list').toEqual(['view'])
    expect(plan.find((p) => p.principal === P_MAP), 'mapping-owned rows are never planned').toBeUndefined()
    expect(plan.find((p) => p.principal === P_MIX), 'a single manual row next to mapping rows is no duplicate').toBeUndefined()
    expect(pub, 'the ranked pair beside an unranked role still converges').toBeTruthy()
    expect(pub!.keep).toBe('comment')
    expect(pub!.remove, 'the publish role is exempt — only the ranked loser goes').toEqual(['view'])
    const cov = plan.find((p) => p.principal === P_COV)
    expect(cov, 'the exempt-covering pair is planned').toBeTruthy()
    expect(cov!.keep).toBe('edit')
    expect(cov!.remove).toEqual(['view'])
    for (const p of plan) expect(p.remove, 'no removal list ever names manage or an unranked role').not.toContain(`role:${pubRoleId}`)
    // dry-run wrote nothing
    expect((await rowsOf(P_DUP)).length).toBe(3)

    await executeConvergence(adminPool, app, plan, () => {})

    // stacked principal: one row (the custom role), tuples converged to its bundle
    expect(await rowsOf(P_DUP)).toEqual([{ role_id: roleId, builtin_capability: null, origin: 'manual' }])
    const dupRels = await relationsOf(P_DUP)
    expect(dupRels).not.toContain('commenter')
    expect(await check(fgaClient, P_DUP, 'edit', { type: 'space', id: spaceId }), 'kept role still in force').toBe(true)

    // manager: manage row + tuple survive; view/comment converge to comment
    const mgrRows = await rowsOf(P_MGR)
    expect(mgrRows).toEqual([
      { role_id: null, builtin_capability: 'comment', origin: 'manual' },
      { role_id: null, builtin_capability: 'manage', origin: 'manual' },
    ])
    expect(await relationsOf(P_MGR), 'the manager leaf is untouched').toContain('manager')

    // mapping-owned principal untouched, rows and tuples
    expect((await rowsOf(P_MAP)).map((r) => r.origin)).toEqual(['mapping', 'mapping'])
    expect(await relationsOf(P_MAP)).toContain('commenter')

    // the unranked publish role SURVIVES next to the converged keeper; the stray rowless moderator
    // tuple (no covering row) was swept by the leftover pass
    const pubRows = await rowsOf(P_PUB)
    expect(pubRows.map((r) => r.role_id ?? r.builtin_capability).sort()).toEqual(['comment', pubRoleId].sort())
    const pubRels = await relationsOf(P_PUB)
    expect(pubRels, 'the exempt role keeps its tuple').toContain('publisher')
    expect(pubRels, 'the uncovered legacy moderator tuple is swept').not.toContain('moderator')
    expect(pubRels).not.toContain('viewer')

    // covering across the exemption boundary (design-review (1) pin): the builtin view row went (edit
    // won), but the exempt role still owns view — the viewer tuple SURVIVES, publish untouched
    const covRows = await rowsOf(P_COV)
    expect(covRows.map((r) => r.role_id ?? r.builtin_capability).sort()).toEqual(['edit', covRoleId].sort())
    const covRels = await relationsOf(P_COV)
    expect(covRels, 'the exempt row keeps covering view — the tuple stays').toContain('viewer')
    expect(covRels).toContain('publisher')

    // per-removal audit went through the normal in-tx path. Scoped to THIS space's target and counted
    // across audit_log + audit_outbox (buildApp runs no drain worker, so this run's entries sit in the
    // outbox; an unscoped actor query would ride residue from earlier runs — reviewer-measured vacuity)
    const audited = await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_revoked' AND target = ${`space:${spaceId}`} AND actor = ${'user:operator:converge-536'})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_revoked' AND target = ${`space:${spaceId}`} AND actor = ${'user:operator:converge-536'}) AS n`
    expect(Number(audited[0]!.n), 'THIS run audited its built-in removals as space.access_revoked').toBeGreaterThan(0)

    // operator ledger has the summary entry for the tenant
    const ledger = await adminPool<{ action: string; target: string }[]>`
      SELECT action, target FROM operator_audit_log WHERE actor = 'operator:converge-536' ORDER BY seq DESC LIMIT 5`
    expect(ledger.some((l) => l.action === 'roles.duplicates_converged' && l.target === `tenant:${TENANT}`)).toBe(true)

    // idempotent: a re-plan finds nothing left
    const replan = await planConvergence(adminPool, () => {})
    expect(replan.find((p) => p.spaceId === spaceId)).toBeUndefined()
  }, 120_000)

  it('the dev shape: one role row + a rowless commenter — display collapses, the residue converges', async () => {
    // display (listSpaceAccess): the custom role's EXPANSION tuples are not independent grant rows;
    // the uncovered legacy commenter still shows (it IS an independent legacy grant)
    const access = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: TENANT, userId: OWNER })
    const resRows = access.filter((g) => g.grantee === P_RES)
    expect(resRows.map((g) => g.capability).sort(), 'expansion caps filtered; the legacy comment shows').toEqual(['comment'])

    // the fga-aware plan catches the residue (no row is removed)
    const plan = await planConvergence(adminPool, () => {}, fgaClient)
    const item = plan.find((p) => p.principal === P_RES)
    expect(item, 'the rowless residue is planned').toBeTruthy()
    expect(item!.removeRows, 'no row removal for a residue-only item').toEqual([])
    expect(item!.rowlessResidue).toEqual(['comment'])

    await executeConvergence(adminPool, app, [item!], () => {})
    expect((await rowsOf(P_RES)), 'the role row is untouched').toEqual([{ role_id: roleId, builtin_capability: null, origin: 'manual' }])
    const rels = await relationsOf(P_RES)
    expect(rels, 'the residue tuple is gone').not.toContain('commenter')
    expect(rels, 'the covered expansion tuples stay').toContain('editor_member')
    // and the fga-aware re-plan is clean for this principal too
    const replan = await planConvergence(adminPool, () => {}, fgaClient)
    expect(replan.find((p) => p.principal === P_RES)).toBeUndefined()
  }, 120_000)

  it('a keeper revoked between plan and apply skips the group (design-review C) — never delete-all', async () => {
    const pa = `user:cvg-race-${STAMP}`
    await insertRow(pa, { builtin: 'view', caps: ['view'], at: '2026-01-01T00:00:00Z' })
    await insertRow(pa, { builtin: 'edit', caps: ['edit'], at: '2026-01-02T00:00:00Z' })
    await writeTuples(fgaClient, tuplesFor(pa, ['viewer', 'viewer_member', 'editor_member']))
    const plan = await planConvergence(adminPool, () => {})
    const item = plan.find((p) => p.principal === pa)!
    expect(item.keep).toBe('edit')
    // the race: the keeper row is revoked after the plan was made
    await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${pa} AND builtin_capability = 'edit'`
    await executeConvergence(adminPool, app, [item], () => {})
    const rows = await rowsOf(pa)
    expect(rows, 'the view row was NOT deleted into a ghost keeper').toEqual([{ role_id: null, builtin_capability: 'view', origin: 'manual' }])
    await deleteTuples(fgaClient, tuplesFor(pa, ['viewer', 'viewer_member', 'editor_member'])).catch(() => {})
  }, 120_000)
})
