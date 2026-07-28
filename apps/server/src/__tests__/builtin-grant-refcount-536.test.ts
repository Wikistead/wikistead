// #536 / ADR-188 §6 item 1: routing built-in grants through the role mechanism is not a tidying exercise.
// It fixes a real loss of access.
//
// A built-in grant used to write FGA tuples with no row behind it, while a custom-role assignment wrote a
// row and counted references on it. The two were therefore invisible to each other. Give Bob a `view`
// grant AND a role that bundles `view`, take ONE of them away, and the shared `viewer` leaf goes with it
//
// - revoke the grant -> the unified table deleted `viewer` outright; the role assignment was still
// there, still listed, still saying Bob may view. He could not.
// - unassign the role -> the refcount consulted OTHER ASSIGNMENTS only, and the grant was not one, so
// the leaf it "owned" was deleted even though a live grant also conferred it.
//
// Both directions are pinned. This is the invariant the whole reference count exists for, and it simply
// did not apply to half the ways access is given.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, grantPageAccess, revokePageAccess } from '../routes/pages.js'
import { assignRoleInTx, unassignRoleInTx } from '../routes/roles.js'
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
let roleId = ''
const subs: string[] = []

const sub = (n: string) => { const s = `refc-${n}-${STAMP}`; subs.push(s); return `user:${s}` }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `refc-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `refc-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleId = `refc-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`refc-${STAMP}`}, ARRAY['view']::text[], 'resource')`
}, 120_000)

afterAll(async () => {
  // the creator fixture's tenant-level tuples must not outlive the suite (offset-isolated store, but
  // decayed shared-tenant state is exactly the #482 flake class)
  await deleteTuples(fgaClient, [
    { user: `user:refc-creator-${STAMP}`, relation: 'member', object: `tenant:${TENANT}` },
    { user: `user:refc-creator-${STAMP}`, relation: 'space_creator', object: `tenant:${TENANT}` },
  ]).catch(() => {})
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const grant = (principal: string, capability: string) =>
  grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capability, plan: 'business' })
const revoke = (principal: string, capability: string) =>
  revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capability, plan: 'business' })
const assign = (principal: string) =>
  assignRoleInTx(db, fgaClient, app.searchDriver, {
    tenant, roleId, capabilities: ['view'], resourceType: 'space', resourceId: spaceId, principal, actorSub: OWNER,
  })
const canView = (principal: string) => check(fgaClient, principal, 'view', { type: 'page', id: pageId })

describe('#536: a built-in grant and a role assignment stop deleting each other', () => {
  it('revoking the GRANT leaves the role assignment working', async () => {
    const p = sub('grant-first')
    await grant(p, 'view')
    await assign(p)
    expect(await canView(p), 'both in force').toBe(true)

    await revoke(p, 'view')

    // The assignment is still there and still says he may view. Before this, the revoke deleted the
    // shared leaf and the row became a promise the system did not keep.
    const rows = await adminPool`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    expect(rows.length, 'the assignment survives').toBe(1)
    expect(await canView(p), 'and still confers view').toBe(true)
  }, 120_000)

  it('unassigning the ROLE leaves the grant working', async () => {
    const p = sub('role-first')
    await assign(p)
    await grant(p, 'view')
    expect(await canView(p), 'both in force').toBe(true)

    const [row] = await adminPool<{ id: string }[]>`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: row.id, actorSub: OWNER })

    expect(await canView(p), 'the grant still confers view').toBe(true)
  }, 120_000)

  it('and when the LAST holder goes, the leaf really does go', async () => {
    // The counterpart. A refcount that never reaches zero is not a fix, it is a leak — access that
    // outlives every reason for it, which on this surface means someone reading what they were removed
    // from. Both removals, in either order, must end at no access.
    const p = sub('last-one-out')
    await grant(p, 'view')
    await assign(p)
    const [row] = await adminPool<{ id: string }[]>`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: row.id, actorSub: OWNER })
    await revoke(p, 'view')
    expect(await canView(p), 'nothing left').toBe(false)
  }, 120_000)

  it('a grant writes a row, and revoking it takes the row away', async () => {
    // The mechanism itself: without the row there is nothing for a reference count to count.
    const p = sub('has-a-row')
    await grant(p, 'edit')
    const after = await adminPool<{ builtin_capability: string; role_id: string | null }[]>`
      SELECT builtin_capability, role_id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(after).toEqual([{ builtin_capability: 'edit', role_id: null }])

    await revoke(p, 'edit')
    const gone = await adminPool`SELECT id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(gone.length, 'the row goes with the grant').toBe(0)
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId }), 'and so does the access').toBe(false)
  }, 120_000)

  it('granting twice is not an error and does not double the row', async () => {
    // The old path just wrote the tuple again. The role path 409s on a duplicate assignment, and adopting
    // it wholesale would have turned a harmless click into a failure the UI has no state to explain.
    const p = sub('twice')
    await grant(p, 'view')
    await grant(p, 'view')
    const rows = await adminPool`SELECT id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(rows.length).toBe(1)
    expect(await canView(p)).toBe(true)
  }, 120_000)

  it('the manager superset is still a single leaf, not its enumerated bundle', async () => {
    // The design-review BLOCK, re-pinned at the new call site: `manage` is not in ROLE_CAPABILITIES, and
    // expansionTuples refuses it as a second layer of defence. Routing built-in grants through that same
    // function means `manage` now arrives there legitimately — so this checks the superset still resolves
    // rather than 400ing, and still reaches space manage and moderate, which no enumeration lists.
    const p = sub('boss')
    await grant(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'space', id: spaceId }), 'space manage').toBe(true)
    expect(await check(fgaClient, p, 'moderate', { type: 'space', id: spaceId }), 'moderate, which the bundle never lists').toBe(true)
    expect(await check(fgaClient, p, 'manage', { type: 'page', id: pageId }), 'page manage_from_space').toBe(true)

    await revoke(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'space', id: spaceId }), 'and it comes back off').toBe(false)
  }, 120_000)
})

// #536 design review (finding 1, REPRODUCED on a live stack): ownership must not be derived from tuple
// presence. A ROWLESS tuple — a grant from before migration 086, or the `manager` leaf createSpace writes
// for the creator — is the SAME grant, untracked; treating it as "someone else already conferred this" gave
// the new row owned_capabilities = {}, and the revoke then deleted the row, deleted no tuples, wrote the
// audit line, emitted the webhook, and answered success while the access stayed. The exact failure the
// shared-table comment warns about: "a grant that cannot be taken away, reported as success".
describe('#536 review: a re-granted rowless tuple is still revocable', () => {
  it('pre-086 tuple + grant + revoke = access actually gone', async () => {
    const p = sub('rowless')
    // the legacy shape: the tuple exists, no row behind it (what every pre-086 grant left behind)
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    expect(await canView(p), 'the legacy tuple confers view').toBe(true)

    await grant(p, 'view')   // idempotent re-grant of the same thing — must OWN it, not defer to it
    await revoke(p, 'view')

    expect(await canView(p), 'revoke revokes, it does not just file paperwork').toBe(false)
  }, 120_000)

  it('the space CREATOR is the no-legacy-data case: grant manage, revoke manage, manage is gone', async () => {
    // createSpace writes the creator's `manager` tuple directly (no row) — so this reproduces on a brand
    // new space with no pre-086 history at all, which is what makes finding 1 launch-relevant.
    const creator = `refc-creator-${STAMP}`
    subs.push(creator)
    // a plain member allowed to create spaces (NOT an admin — an admin manages every space via the tenant
    // link, so "manage revoked" could never be observed and the test would be vacuous)
    await writeTuples(fgaClient, [
      { user: `user:${creator}`, relation: 'member', object: `tenant:${TENANT}` },
      { user: `user:${creator}`, relation: 'space_creator', object: `tenant:${TENANT}` },
    ]).catch(() => {})
    const s2 = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: creator, plan: 'business', name: `refc2-${STAMP}` })).id
    try {
      expect(await check(fgaClient, `user:${creator}`, 'manage', { type: 'space', id: s2 }), 'creator manages').toBe(true)
      await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId: s2, tenantId: TENANT, userId: OWNER, grantee: `user:${creator}`, capability: 'manage', plan: 'business' })
      await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId: s2, tenantId: TENANT, userId: OWNER, grantee: `user:${creator}`, capability: 'manage', plan: 'business' })
      expect(await check(fgaClient, `user:${creator}`, 'manage', { type: 'space', id: s2 }), 'revoked means revoked').toBe(false)
    } finally {
      await adminPool`DELETE FROM role_assignments WHERE resource_id = ${s2}`.catch(() => {})
      await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: s2, userId: OWNER }).catch(() => {})
    }
  }, 120_000)

  it('the ROWLESS fallback consults live assignments before deleting raw tuples', async () => {
    // The reviewer-read third scenario: legacy tuple + a live custom-role assignment + a built-in grant.
    // After the first revoke removes the row, a SECOND revoke falls back to the pre-086 path — which used
    // to delete tuples with no reference count, taking the role assignment's leaf with it.
    const p = sub('fallback')
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    await assign(p) // live custom role bundling view
    await revoke(p, 'view') // no builtin row exists -> fallback path
    expect(await canView(p), 'the live assignment still confers view after a rowless revoke').toBe(true)
  }, 120_000)

  it('a duplicate grant still writes its audit line', async () => {
    // 2: the idempotent early-return skipped auditIfEntitled while the webhook still fired. Before
    // #536 a duplicate grant audited like any other; an audit stream that goes quiet for a subset of
    // successful writes is one nobody can reconcile against the webhook stream.
    const p = sub('audit-dup')
    await grant(p, 'view')
    const before = (await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`}) AS n`)[0].n
    await grant(p, 'view')
    // the audit rides the outbox; give the drain a moment by checking the outbox + log together
    const after = (await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`}) AS n`)[0].n
    expect(Number(after), 'the duplicate grant audited too').toBeGreaterThan(Number(before))
  }, 120_000)
})

// #536 review 3: the page scope had the identical defect and no pin. A page grant wrote a raw tuple
// with no row while a page-scope role assignment reference-counted rows — so revoking either deleted the
// leaf the other still conferred. Routed through the same mechanism now; these are the page-side mirrors
// of the space pins above.
describe('#536 review: page grants and page-scope assignments stop deleting each other', () => {
  const pGrant = (principal: string, relation: string) =>
    grantPageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: principal, relation, plan: 'business' })
  const pRevoke = (principal: string, relation: string) =>
    revokePageAccess(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, grantee: principal, relation, plan: 'business' })
  const pAssign = (principal: string) =>
    assignRoleInTx(db, fgaClient, app.searchDriver, {
      tenant, roleId, capabilities: ['view'], resourceType: 'page', resourceId: pageId, principal, actorSub: OWNER,
    })

  it('revoking the page GRANT leaves the page-scope assignment working', async () => {
    const p = sub('pg-grant-first')
    await pGrant(p, 'view')
    await pAssign(p)
    expect(await canView(p), 'both in force').toBe(true)
    await pRevoke(p, 'view')
    expect(await canView(p), 'the assignment still confers view').toBe(true)
  }, 120_000)

  it('unassigning the page ROLE leaves the page grant working, and the last removal ends at none', async () => {
    const p = sub('pg-role-first')
    await pAssign(p)
    await pGrant(p, 'view')
    const [row] = await adminPool<{ id: string }[]>`
      SELECT id FROM role_assignments WHERE role_id = ${roleId} AND resource_type = 'page' AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: row.id, actorSub: OWNER })
    expect(await canView(p), 'the grant survives the unassign').toBe(true)
    await pRevoke(p, 'view')
    expect(await canView(p), 'and the last holder going takes the access with it').toBe(false)
  }, 120_000)

  it('a rowless legacy page tuple: re-grant then revoke actually revokes', async () => {
    const p = sub('pg-rowless')
    await writeTuples(fgaClient, [{ user: p, relation: 'view_direct', object: `page:${pageId}` }])
    expect(await canView(p), 'legacy tuple confers').toBe(true)
    await pGrant(p, 'view')
    await pRevoke(p, 'view')
    expect(await canView(p), 'revoked means revoked').toBe(false)
  }, 120_000)

  it('page `manage` still grants and revokes through the superset guard', async () => {
    // `manage` is absent from PAGE_CAP_RELATION (custom roles cannot request it); the built-in grant path
    // reaches it via allowSuperset -> manage_direct. A 400 here would mean the routing broke an operation
    // the direct path always supported.
    const p = sub('pg-manage')
    await pGrant(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'page', id: pageId }), 'manage granted').toBe(true)
    await pRevoke(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'page', id: pageId }), 'manage revoked').toBe(false)
  }, 120_000)
})
