// #553 / ADR-199 §2 (T1): the editor-noun composite grant. N capabilities = N single-capability
// built-in rows in ONE transaction; each arm independently owned, revocable and idempotent; the bare
// capability form grants exactly what it says (the honest-API pin); the replace sweep keeps BOTH arms.
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, grantSpaceAccessComposite, revokeSpaceAccessComposite } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
const subs: string[] = []
// #624: a grant names somebody who is HERE — the routes refuse a principal with no members row
// now, so the fixture seats the sub it is about to grant to. That is what the test always meant.
const sub = async (n: string) => {
  const s = `cg-${n}-${STAMP}`
  subs.push(s)
  await seatMembers(adminPool, TENANT, [s])
  return `user:${s}`
}

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `cg-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `cg-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
}, 120_000)

afterAll(async () => {
  // #624: the fixture seated these; take them out so the shared dev tenant is not widened
  await unseatMembers(adminPool, TENANT, subs)
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const rowsOf = (principal: string) => adminPool<{ id: string; builtin_capability: string | null; origin: string; owned_capabilities: string[] }[]>`
  SELECT id, builtin_capability, origin, owned_capabilities FROM role_assignments
  WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability`
const composite = (principal: string, caps: string[]) =>
  grantSpaceAccessComposite(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capabilities: caps, plan: 'business' })

describe('#553 T1: the editor-noun composite grant', () => {
  it('grants N single-capability rows in one pass; both arms hold; each is independently revocable', async () => {
    const p = await sub('pair')
    await composite(p, ['edit', 'comment'])
    const rows = await rowsOf(p)
    expect(rows.map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
    for (const r of rows) {
      expect(r.origin).toBe('manual')
      expect(r.owned_capabilities, 'a built-in row never exceeds its single capability').toEqual([r.builtin_capability])
    }
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, p, 'comment', { type: 'page', id: pageId })).toBe(true)
    // revoke the edit arm — comment stays (the independence this ticket exists for)
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    expect((await rowsOf(p)).map((r) => r.builtin_capability)).toEqual(['comment'])
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId })).toBe(false)
    expect(await check(fgaClient, p, 'comment', { type: 'page', id: pageId }), 'comment survives the edit revoke').toBe(true)
  }, 120_000)

  it('is idempotent per arm: a duplicate composite leaves two rows; a half-held principal lands the other arm', async () => {
    const p = await sub('idem')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'comment', plan: 'business' })
    await composite(p, ['edit', 'comment'])
    expect((await rowsOf(p)).map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
    await composite(p, ['edit', 'comment']) // full duplicate
    expect((await rowsOf(p)).map((r) => r.builtin_capability), 'still exactly two rows').toEqual(['comment', 'edit'])
  }, 120_000)

  it('the bare capability form grants exactly what it says (one row, no comment ride-along)', async () => {
    const p = await sub('bare')
    const res = await app.inject({
      method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relation: 'edit' },
    })
    expect(res.statusCode).toBe(204)
    expect((await rowsOf(p)).map((r) => r.builtin_capability), 'one row, edit only — the honest API').toEqual(['edit'])
  }, 120_000)

  it('the composite REPLACES the principal\'s other role (the #536 sweep keeps both arms)', async () => {
    const p = await sub('sweep')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business' })
    const res = await app.inject({
      method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relations: ['edit', 'comment'] },
    })
    expect(res.statusCode).toBe(204)
    const rows = await rowsOf(p)
    expect(rows.map((r) => r.builtin_capability), 'view replaced; BOTH arms kept').toEqual(['comment', 'edit'])
  }, 120_000)

  it('one composite add audits one event per arm (two precise records, ADR-199 ruling)', async () => {
    const p = await sub('audit')
    const count = async () => Number((await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`}) AS n`)[0]!.n)
    const before = await count()
    await composite(p, ['edit', 'comment'])
    expect((await count()) - before, 'two audit events for one noun add').toBe(2)
  }, 120_000)
})

// #553 review D: the plural wire form is a closed set of ruled bundles, not a free multi-grant —
// an arbitrary capability list must not slip N roles past the #536 one-role convergence.
describe('#553 review D: composite allowlist', () => {
  it('rejects a non-bundle relations[] with 400 and writes nothing', async () => {
    const p = await sub('freeform')
    for (const relations of [['view', 'comment', 'edit', 'moderate', 'manage'], ['view'], ['edit', 'manage'], ['comment']]) {
      const res = await app.inject({
        method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
        payload: { grantee: p, relations },
      })
      expect(res.statusCode, relations.join('+')).toBe(400)
    }
    expect((await rowsOf(p)).length, 'nothing written').toBe(0)
  }, 120_000)

  it('accepts the ruled editor bundle in either order', async () => {
    const p = await sub('order')
    const res = await app.inject({
      method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relations: ['comment', 'edit'] },
    })
    expect(res.statusCode).toBe(204)
    expect((await rowsOf(p)).map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
  }, 120_000)
})

// #553(a) /the composite REVOKE. The reviewer reproduced the state this closes — the
// folded editor row's × fired two DELETEs, and stopping after the first left the principal "revoked"
// with commenting intact. The ruling: one request, one transaction, all arms or none.
describe('#553revoking a folded noun takes every arm, in one transaction', () => {
  const canComment = (p: string) => check(fgaClient, p, 'comment', { type: 'page', id: pageId })
  const canEdit = (p: string) => check(fgaClient, p, 'edit', { type: 'page', id: pageId })

  it('one DELETE with relations[] removes both rows and both leaves', async () => {
    const p = await sub('rev-both')
    await composite(p, ['edit', 'comment'])
    expect(await canEdit(p)).toBe(true)
    expect(await canComment(p)).toBe(true)

    const res = await app.inject({
      method: 'DELETE', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relations: ['edit', 'comment'] },
    })
    expect(res.statusCode).toBe(200) // #596: revoke answers 200 + the honesty payload
    expect((await rowsOf(p)).length, 'no arm left behind').toBe(0)
    expect(await canEdit(p)).toBe(false)
    expect(await canComment(p), 'the leftover this exists to prevent').toBe(false)
  }, 120_000)

  it('the whole fold is ONE write, so there is no moment where half of it has landed', async () => {
    // The discriminating pin. "Both arms end up gone" is true of a loop as well, so it proves nothing
    // about atomicity: what distinguishes the fix is that the arms are deleted TOGETHER — one
    // transaction, one FGA write. Revoking arm by arm (the client's old behaviour, or a server-side
    // loop) issues one write per arm and passes through the half state in between.
    const p = await sub('rev-onewrite')
    await composite(p, ['edit', 'comment'])
    let writes = 0
    const counting = new Proxy(fgaClient, {
      get: (t, prop, recv) => prop === 'write'
        ? async (...a: unknown[]) => { writes++; return (Reflect.get(t, prop, recv) as (...x: unknown[]) => Promise<unknown>).apply(t, a) }
        : Reflect.get(t, prop, recv),
    })
    await revokeSpaceAccessComposite(db, counting, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })
    expect(writes, 'one write for the whole noun — not one per arm').toBe(1)
    expect((await rowsOf(p)).length).toBe(0)
    expect(await canComment(p)).toBe(false)
  }, 120_000)

  it('a FAILURE mid-revoke leaves the principal exactly as they were (all or nothing)', async () => {
    // the acceptance condition from the ruling: not just "the client sends one request", but "a failure
    // cannot produce the half state either". The failure is injected where it can actually happen —
    // the FGA delete, which runs last inside the transaction.
    const p = await sub('rev-rollback')
    await composite(p, ['edit', 'comment'])
    const spy = { calls: 0 }
    // a PROXY, not a spread: the client's methods live on its prototype, and a spread copy would fail
    // for the wrong reason (before any row was touched), which would pin nothing.
    const broken = new Proxy(fgaClient, {
      get: (t, prop, recv) => prop === 'write'
        ? async () => { spy.calls++; throw new Error('FGA down') }
        : Reflect.get(t, prop, recv),
    })
    await expect(revokeSpaceAccessComposite(db, broken, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })).rejects.toThrow()
    expect(spy.calls, 'the failure was reached (otherwise this pin proves nothing)').toBeGreaterThan(0)
    expect((await rowsOf(p)).map((r) => r.builtin_capability), 'both rows rolled back').toEqual(['comment', 'edit'])
    expect(await canEdit(p), 'and access is untouched').toBe(true)
    expect(await canComment(p)).toBe(true)

    // and the real one still works afterwards
    await revokeSpaceAccessComposite(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })
    expect((await rowsOf(p)).length).toBe(0)
  }, 120_000)

  it('a ROWLESS arm goes too (a legacy comment leaf must not survive the fold\'s revoke)', async () => {
    const p = await sub('rev-rowless')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    // the pre-composite shape: a comment leaf with no row of its own
    const { writeTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, [{ user: p, relation: 'commenter', object: `space:${spaceId}` }])
    expect(await canComment(p)).toBe(true)
    await revokeSpaceAccessComposite(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })
    expect(await canComment(p), 'the untracked arm is not a way to keep commenting').toBe(false)
    expect(await canEdit(p)).toBe(false)
  }, 120_000)

  // #553 re-review: BOTH of these were reproduced by the reviewer against the first version.
  it('a comment row that owns nothing (the migration shape) still loses its leaf', async () => {
    // migrate-comment-independence-553 pass 1a inserts a comment row with owned_capabilities = [] when
    // the leaf already existed. Removing that row deletes nothing by ownership, and because a row
    // EXISTS the rowless arm was skipped too — so the fold reported success and the principal kept
    // commenting. dev happens to have zero such rows, so no review could ever have caught it.
    const p = await sub('rev-unowned')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    const { writeTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, [{ user: p, relation: 'commenter', object: `space:${spaceId}` }])
    await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (gen_random_uuid()::text, ${TENANT}, NULL, 'comment', 'space', ${spaceId}, ${p}, ${[]}, 'manual')`
    expect(await canComment(p)).toBe(true)

    await revokeSpaceAccessComposite(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })
    expect((await rowsOf(p)).length).toBe(0)
    expect(await canComment(p), 'a row that owns nothing is not a licence to keep the leaf').toBe(false)
  }, 120_000)

  it('an arm whose leaf is already gone does not abort the whole revoke', async () => {
    // deleting a tuple that is not there is an FGA error, and it rolled the transaction back: the
    // fold threw and removed NOTHING — a revoke you can press with no effect.
    const p = await sub('rev-halfgrant')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    expect(await canEdit(p)).toBe(true)
    expect(await canComment(p), 'no comment arm at all — the state this used to choke on').toBe(false)

    await revokeSpaceAccessComposite(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
    })
    expect((await rowsOf(p)).length, 'the arm that WAS there is gone').toBe(0)
    expect(await canEdit(p)).toBe(false)
  }, 120_000)

  it('a live CUSTOM ROLE covering comment keeps its leaf when the editor noun is revoked', async () => {
    // therule the recomputed delete set must not break: another row still confers comment, so
    // comment stays — taking the editor noun away is not taking the role away.
    const p = await sub('rev-covered')
    const roleId = `cg-role-${STAMP}`
    await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`cg-cov-${STAMP}`}, ARRAY['comment']::text[], 'resource')
      ON CONFLICT (id) DO NOTHING`
    try {
      // Built directly, because the runtime cannot produce it any more: #536's convergence sweeps a
      // principal's other manual rows on every add, so a custom role and a built-in noun cannot be
      // added side by side today. The state still EXISTS in data that predates that rule, and the
      // covering rule is what protects it — that is what this pins.
      await composite(p, ['edit', 'comment'])
      await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
        VALUES (gen_random_uuid()::text, ${TENANT}, ${roleId}, NULL, 'space', ${spaceId}, ${p}, ${[]}, 'manual')`
      await revokeSpaceAccessComposite(db, fgaClient, app.searchDriver, {
        spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capabilities: ['edit', 'comment'], plan: 'business',
      })
      expect(await canEdit(p), 'the noun is gone').toBe(false)
      expect(await canComment(p), 'the ROLE still confers comment — its leaf is not collateral').toBe(true)
    } finally {
      await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`.catch(() => {})
      await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
    }
  }, 120_000)

  it('the same allowlist as the grant: a free-form relations[] is 400 and removes nothing', async () => {
    const p = await sub('rev-freeform')
    await composite(p, ['edit', 'comment'])
    for (const relations of [['edit'], ['edit', 'manage'], ['view', 'comment']]) {
      const res = await app.inject({ method: 'DELETE', url: `/spaces/${spaceId}/access`, headers: dev, payload: { grantee: p, relations } })
      expect(res.statusCode, relations.join('+')).toBe(400)
    }
    expect((await rowsOf(p)).length, 'nothing removed by a refused shape').toBe(2)
  }, 120_000)

  it('the singular form still means exactly one capability (independence, non-regression)', async () => {
    const p = await sub('rev-single')
    await composite(p, ['edit', 'comment'])
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    expect(await canEdit(p)).toBe(false)
    expect(await canComment(p), 'comment is independent — taking edit does not take it').toBe(true)
  }, 120_000)
})
