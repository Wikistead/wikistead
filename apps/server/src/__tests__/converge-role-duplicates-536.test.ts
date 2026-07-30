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
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { buildApp } from '../app.js'
import { planConvergence, executeConvergence, pickKeeper, type DupRow } from '../scripts/converge-role-duplicates-536.js'
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
const P_DUP = `user:cvg-dup-${STAMP}`
const P_MGR = `user:cvg-mgr-${STAMP}`
const P_MAP = `user:cvg-map-${STAMP}`

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
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
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

  it('dry-run plans without writing; apply converges rows AND tuples; manage/mapping survive; ledger written', async () => {
    const plan = await planConvergence(adminPool)
    const dup = plan.find((p) => p.principal === P_DUP)
    const mgr = plan.find((p) => p.principal === P_MGR)
    expect(dup, 'the stacked principal is planned').toBeTruthy()
    expect(dup!.keep, 'the custom role (view+edit) is the strongest keeper').toBe(`role:${roleId}`)
    expect(dup!.remove.sort()).toEqual(['comment', 'view'])
    expect(mgr, 'the manager duplicate pair is planned (manage itself excluded)').toBeTruthy()
    expect(mgr!.keep).toBe('comment')
    expect(plan.find((p) => p.principal === P_MAP), 'mapping-owned rows are never planned').toBeUndefined()
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

    // operator ledger has the summary entry for the tenant
    const ledger = await adminPool<{ action: string; target: string }[]>`
      SELECT action, target FROM operator_audit_log WHERE actor = 'operator:converge-536' ORDER BY seq DESC LIMIT 5`
    expect(ledger.some((l) => l.action === 'roles.duplicates_converged' && l.target === `tenant:${TENANT}`)).toBe(true)

    // idempotent: a re-plan finds nothing left
    const replan = await planConvergence(adminPool)
    expect(replan.find((p) => p.spaceId === spaceId)).toBeUndefined()
  }, 120_000)
})
