// #596: a revoke that changes nothing must not report success.
//
// The defect: revoking a capability that ANOTHER live assignment also confers deleted no FGA tuple
// (correct — the reference count protects the other assignment's access) but still answered
// success, wrote an audit entry and fired a webhook. The manager removes someone and they keep the
// access; the EE ledger is hash-chained, so "a revoke that never happened" becomes a tamper-proof
// lie about an authorization change.
//
// The fix is NOT "always delete" (that would take the covering assignment's access with it). It is
// honesty:
//   - a rowless revoke whose capability is still covered → 409 `still_covered` + `coveredBy`,
//     nothing audited, no webhook;
//   - a row-backed removal that really deletes the row → success, but the response NAMES what still
//     grants the capability (`stillCovered`) so the surface can say "removed, but X still grants it".
//
// Measured on a real Postgres + OpenFGA stack. Three shapes per scope (page AND space): (a) a single
// role, (b) two roles covering the same capability, (c) a role plus a direct built-in grant.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, grantPageAccess, revokePageAccess } from '../routes/pages.js'
import { assignRoleInTx, unassignRoleInTx } from '../routes/roles.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const tenant = { id: TENANT, plan: 'business' }

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleA = ''
let roleB = ''

const sub = (n: string) => `user:rh596-${n}-${STAMP}`
const P = { type: 'page' as const, id: '' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `rh596-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `rh596-${STAMP}` })).id
  P.id = pageId
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleA = `rh596-a-${STAMP}`
  roleB = `rh596-b-${STAMP}`
  // Two DIFFERENT roles that both confer `view` — the coverage shape the defect lives in.
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleA}, ${TENANT}, ${roleA}, ARRAY['view']::text[], 'resource')`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleB}, ${TENANT}, ${roleB}, ARRAY['view']::text[], 'resource')`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id IN (${spaceId}, ${pageId})`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id IN (${roleA}, ${roleB})`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  // Scoped to THIS file's page. A tenant-wide delete here removed rows other suites had enqueued and
  // were about to drain — measured: it made search-sync's "drains the accumulated rows" assert 0
  // (the #482 shared-state class).
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT} AND page_id = ${pageId}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const assign = (roleId: string, resourceType: 'page' | 'space', resourceId: string, principal: string) =>
  assignRoleInTx(db, fgaClient, app.searchDriver, {
    tenant, roleId, capabilities: ['view'], resourceType, resourceId, principal, actorSub: OWNER,
  })
const canView = (principal: string) => check(fgaClient, principal, 'view', P)

// The audit ledger's own count for THIS resource: outbox + log together, drained first so a pending
// intent is not mistaken for an absent one (#481's shape).
async function auditRows(target: string): Promise<number> {
  await drainAuditFor(adminPool, TENANT)
  const [{ n }] = await adminPool<[{ n: string }]>`
    SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${target}
      AND action IN ('page.access_revoked', 'space.access_revoked', 'role.unassigned')`
  return Number(n)
}

// Capture the revocation webhooks fired during `fn`.
async function firedRevokes(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const off = onDomainEvent((e) => {
    if (e.type === 'page.access_revoked' || e.type === 'space.access_revoked') seen.push(e.type)
  })
  try { await fn().catch(() => {}) } finally { off() }
  // emit() dispatches synchronously into the handler list, so nothing is in flight here.
  return seen
}

describe('#596 page scope: a revoke that changes nothing refuses instead of lying', () => {
  it('(a) single role: unassign really removes the access, and reports nothing still covers it', async () => {
    const p = sub('pg-single')
    const a = await assign(roleA, 'page', pageId, p)
    expect(await canView(p), 'assigned').toBe(true)
    const out = await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: a, actorSub: OWNER })
    expect(out.deleted).toBe(true)
    expect(out.stillCovered, 'nothing else grants view').toEqual([])
    expect(await canView(p), 'the access is really gone').toBe(false)
  }, 120_000)

  it('(b) two roles covering `view`: the first unassign SAYS the capability is still granted, and by what', async () => {
    const p = sub('pg-two-roles')
    const a = await assign(roleA, 'page', pageId, p)
    await assign(roleB, 'page', pageId, p)
    const out = await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: a, actorSub: OWNER })
    expect(out.deleted, 'the row really went').toBe(true)
    // The defect was reporting this as a plain success. The row deletion IS a real change, so it stays
    // a success — but the caller must learn that the ACCESS did not go, and which assignment keeps it.
    expect(out.stillCovered.map((c) => c.capability)).toEqual(['view'])
    expect(out.stillCovered[0].via, 'names the covering role').toBe(roleB)
    expect(await canView(p), 'and the access is indeed still there').toBe(true)
  }, 120_000)

  it('(c) role + direct grant: revoking the GRANT refuses with 409 still_covered — no audit, no webhook', async () => {
    const p = sub('pg-grant-covered')
    // The ROWLESS shape: a pre-086 grant is a bare tuple with no assignment row (migration 086 refuses
    // to invent rows for them). Plus a live role conferring the same capability. Revoking the rowless
    // grant can delete nothing — the role still confers it — which is the branch that used to answer
    // success while changing nothing at all.
    await writeTuples(fgaClient, [{ user: p, relation: 'view_direct', object: `page:${pageId}` }])
    await assign(roleA, 'page', pageId, p) // the covering assignment

    const before = await auditRows(`page:${pageId}`)
    const fired = await firedRevokes(() =>
      revokePageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: p, relation: 'view', plan: 'business' }),
    )
    // the call itself must reject with the honest code + the coverage
    await expect(
      revokePageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: p, relation: 'view', plan: 'business' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'still_covered', coveredBy: [roleA] })

    expect(fired, 'no webhook for a revoke that did not happen').toEqual([])
    expect(await auditRows(`page:${pageId}`), 'no audit row either — the ledger stays true').toBe(before)
    expect(await canView(p), 'the covering role keeps the access (non-regression)').toBe(true)
  }, 120_000)

  it('the HTTP revoke answers 409 with coveredBy, and 200 + stillCovered when it really removes', async () => {
    const p = sub('pg-http')
    await writeTuples(fgaClient, [{ user: p, relation: 'view_direct', object: `page:${pageId}` }])
    await assign(roleA, 'page', pageId, p)
    const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    const refused = await app.inject({ method: 'DELETE', url: `/pages/${pageId}/access`, headers: H, payload: { grantee: p, relation: 'view' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'still_covered', coveredBy: [roleA] })

    // now remove the covering role: the grant becomes the only holder and the revoke goes through
    const [asg] = await adminPool<{ id: string }[]>`SELECT id FROM role_assignments WHERE role_id = ${roleA} AND resource_id = ${pageId} AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: asg.id, actorSub: OWNER })
    const ok = await app.inject({ method: 'DELETE', url: `/pages/${pageId}/access`, headers: H, payload: { grantee: p, relation: 'view' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ removed: true, stillCovered: [] })
    expect(await canView(p), 'and the access really went this time').toBe(false)
  }, 120_000)
})

// Review findings F1–F3, each pinned where it was found.
describe('#596 review: coverage is FGA truth, names are manage-only, and the ledger says what happened', () => {
  it('F2: a ROWLESS covering tuple is reported too — the row-only rule called this a clean removal', async () => {
    // The mirror image of scenario (c): the rowless grant is what SURVIVES, and the role is what is
    // removed. assignRoleInTx does not own a leaf that already existed, so nothing is deleted and the
    // access plainly remains — while a coverage rule that reads only role_assignments rows saw no
    // covering row and answered `stillCovered: []`, i.e. a plain success toast over unchanged access.
    const p = sub('pg-rowless-covers')
    await writeTuples(fgaClient, [{ user: p, relation: 'view_direct', object: `page:${pageId}` }])
    const a = await assign(roleA, 'page', pageId, p)
    const out = await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: a, actorSub: OWNER })
    expect(out.deleted).toBe(true)
    expect(await canView(p), 'the rowless grant still confers view').toBe(true)
    // named by the capability itself: a direct grant of `view` IS what the client calls a viewer
    expect(out.stillCovered).toEqual([{ capability: 'view', via: 'view' }])
  }, 120_000)

  it('F3: when nothing was lost, the ledger records the UNASSIGNMENT — not an access revocation', async () => {
    // `page.access_revoked` means "a principal LOST a relation" (the event catalog's own words).
    // Writing it into a hash-chained ledger while the principal kept every capability is the same lie
    // in a different column, so the audit falls back to the vocabulary that is true: role.unassigned.
    const p = sub('pg-audit-action')
    await grantPageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: p, relation: 'view', plan: 'business' })
    await assign(roleA, 'page', pageId, p) // covers `view` from another row
    const [grantRow] = await adminPool<{ id: string }[]>`
      SELECT id FROM role_assignments WHERE resource_type = 'page' AND resource_id = ${pageId} AND principal = ${p} AND builtin_capability = 'view'`
    // A DELTA around this one call — a time window would sweep in the legitimate revocations the
    // earlier tests in this file wrote against the same page (measured: it did).
    const actions = async () => {
      await drainAuditFor(adminPool, TENANT)
      const [r] = await adminPool<[{ revoked: string; unassigned: string }]>`
        SELECT count(*) FILTER (WHERE action = 'page.access_revoked')::text AS revoked,
               count(*) FILTER (WHERE action = 'role.unassigned')::text AS unassigned
        FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`page:${pageId}`}`
      return { revoked: Number(r.revoked), unassigned: Number(r.unassigned) }
    }
    const before = await actions()
    const fired = await firedRevokes(() =>
      revokePageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: p, relation: 'view', plan: 'business' }),
    )
    expect(grantRow, 'the grant really had a row (else this pins the wrong branch)').toBeTruthy()
    expect(fired, 'no access_revoked webhook: the principal lost nothing').toEqual([])
    const after = await actions()
    expect(after.revoked - before.revoked, 'no "access revoked" line for access that was not revoked').toBe(0)
    expect(after.unassigned - before.unassigned, 'the removal that DID happen is recorded').toBe(1)
    expect(await canView(p), 'and the role still confers view').toBe(true)
  }, 120_000)

  it('F1: a share-only manager gets the refusal WITHOUT the tenant role name', async () => {
    // The page grant/revoke verb is `share`; role DEFINITIONS are gated on `manage` (ADR-202 §1). A
    // coverage report must not be the back door that hands a share-only holder the tenant's role names.
    const victim = sub('pg-redact-victim')
    const sharer = sub('pg-redact-sharer')
    await writeTuples(fgaClient, [{ user: victim, relation: 'view_direct', object: `page:${pageId}` }])
    await assign(roleA, 'page', pageId, victim)
    await writeTuples(fgaClient, [{ user: sharer, relation: 'share_direct', object: `page:${pageId}` }])
    expect(await check(fgaClient, sharer, 'manage', P), 'the sharer is deliberately NOT a manager').toBe(false)

    const asSharer = { pageId, tenantId: TENANT, userId: sharer.slice('user:'.length), grantee: victim, relation: 'view', plan: 'business' }
    await expect(revokePageAccess(db, fgaClient, app.searchDriver, asSharer))
      .rejects.toMatchObject({ statusCode: 409, code: 'still_covered', coveredBy: [] })
    // ...and a manager, who could read the same name from the role endpoints, still gets it
    await expect(revokePageAccess(db, fgaClient, app.searchDriver, { ...asSharer, userId: OWNER }))
      .rejects.toMatchObject({ statusCode: 409, coveredBy: [roleA] })
  }, 120_000)
})

describe('#596 space scope: the same three shapes', () => {
  const canViewSpace = (p: string) => check(fgaClient, p, 'view', P) // page inherits space viewer

  it('(a) single role: unassign removes the access and reports no coverage', async () => {
    const p = sub('sp-single')
    const a = await assign(roleA, 'space', spaceId, p)
    expect(await canViewSpace(p)).toBe(true)
    const out = await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: a, actorSub: OWNER })
    expect(out.stillCovered).toEqual([])
    expect(await canViewSpace(p)).toBe(false)
  }, 120_000)

  it('(b) two roles: the first unassign names the surviving role', async () => {
    const p = sub('sp-two-roles')
    const a = await assign(roleA, 'space', spaceId, p)
    await assign(roleB, 'space', spaceId, p)
    const out = await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: a, actorSub: OWNER })
    expect(out.stillCovered.map((c) => `${c.capability}@${c.via}`)).toEqual([`view@${roleB}`])
    expect(await canViewSpace(p), 'still granted by the other role').toBe(true)
  }, 120_000)

  it('(c) role + rowless grant: revokeSpaceAccess refuses with 409 — no audit, no webhook', async () => {
    const p = sub('sp-grant-covered')
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    await assign(roleA, 'space', spaceId, p)

    const before = await auditRows(`space:${spaceId}`)
    const fired = await firedRevokes(() =>
      revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business' }),
    )
    await expect(
      revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'still_covered', coveredBy: [roleA] })
    expect(fired, 'no webhook').toEqual([])
    expect(await auditRows(`space:${spaceId}`), 'no audit row').toBe(before)
    expect(await canViewSpace(p), 'the role still grants it').toBe(true)
  }, 120_000)
})
