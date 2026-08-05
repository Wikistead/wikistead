// #619 re-review: the rowless revoke forgave a refusal it should not have.
//
// #619's first fix made an already-gone revoke succeed by asking the store to delete the capability's
// WHOLE leaf set and treating "did not exist" as convergence. That is only sound for a one-leaf
// capability. `view` expands to TWO leaves (viewer + viewer_member, space-grant-expansion.ts) and an FGA
// write is atomic per batch, so a principal holding only `viewer` — what every grant made before #258
// looks like, which is why backfillSpaceViewerMembers exists — failed the batch on the ABSENT leaf and
// the forgiveness reported success while `viewer` still granted view. A revoke that answers 200, writes
// an audit line and fires a webhook while the access survives is the exact shape #596 exists to forbid.
//
// So the rule these tests hold the code to is not "forgive the right errors" but "decide the delete set
// from the tuples that are actually there" (the composite revoke's heldRelations read, already in the
// same file). The multi-leaf capabilities are DISCOVERED from the relation table rather than named, so a
// capability that gains a second leaf later is measured by existing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { createSpace, deleteSpace, revokeSpaceAccess } from '../routes/spaces.js'
import { SPACE_GRANT_RELATIONS } from '../space-grant-expansion.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import { buildApp } from '../app.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

// Every capability whose grant is more than one tuple — the shape the batch-atomicity trap needs.
const MULTI_LEAF = Object.entries(SPACE_GRANT_RELATIONS).filter(([, leaves]) => leaves.length > 1)

let app: FastifyInstance
let db: TenantDb
let spaceId = ''

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `rlp619-${STAMP}` })).id
}, 180_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

// What the store actually holds for this principal on this space.
const heldFor = async (grantee: string): Promise<Set<string>> => {
  const { tuples } = await fgaClient.read({ user: grantee, object: `space:${spaceId}` })
  return new Set((tuples ?? []).map((t) => t.key?.relation ?? ''))
}

const revoke = (grantee: string, capability: string) =>
  revokeSpaceAccess(db, fgaClient, app.searchDriver, {
    spaceId, tenantId: TENANT, userId: OWNER, grantee, capability, plan: 'business',
  })

async function auditRows(): Promise<number> {
  await drainAuditFor(adminPool, TENANT)
  const [{ n }] = await adminPool<[{ n: string }]>`
    SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`space:${spaceId}`}
      AND action = 'space.access_revoked'`
  return Number(n)
}

async function firedRevokes(fn: () => Promise<unknown>): Promise<number> {
  let seen = 0
  const off = onDomainEvent((e) => { if (e.type === 'space.access_revoked') seen++ })
  try { await fn() } finally { off() }
  return seen
}

describe('#619: a rowless revoke deletes what is there, and only claims what it did', () => {
  it('the relation table still has a multi-leaf capability (otherwise the cases below prove nothing)', () => {
    expect(MULTI_LEAF.map(([cap]) => cap), 'discovered from SPACE_GRANT_RELATIONS').not.toEqual([])
  })

  for (const [capability, leaves] of MULTI_LEAF) {
    it(`takes ${capability} away when only ONE of its ${leaves.length} leaves is present`, async () => {
      const grantee = `user:rlp619-${capability}-${STAMP}`
      await ensureMembers(TENANT, [grantee.slice('user:'.length)])
      // The pre-#258 shape, written straight to the store: a grant with NO assignment row and only the
      // first leaf. Going through grantSpaceAccess would write both leaves and a row, i.e. neither half
      // of the trap.
      await writeTuples(fgaClient, [{ user: grantee, relation: leaves[0]!, object: `space:${spaceId}` }])
      expect(await heldFor(grantee), 'the half-present starting state').toEqual(new Set([leaves[0]]))

      await revoke(grantee, capability)

      // The assertion the old pin could not make: not "it answered 200" but "the access is gone".
      const after = await heldFor(grantee)
      for (const leaf of leaves) {
        expect(after.has(leaf), `${leaf} still grants ${capability} after a revoke that reported success`).toBe(false)
      }
      await deleteTuples(fgaClient, memberTuples(TENANT, [grantee.slice('user:'.length)])).catch(() => {})
    }, 120_000)
  }

  it('a revoke with nothing left to take succeeds — and does not narrate a removal', async () => {
    const grantee = `user:rlp619-noop-${STAMP}`
    await ensureMembers(TENANT, [grantee.slice('user:'.length)])
    expect(await heldFor(grantee), 'nothing granted to begin with').toEqual(new Set())

    const before = await auditRows()
    const fired = await firedRevokes(() => revoke(grantee, 'view'))

    // Success, because the caller's desired state already holds (#619's actual ask) …
    expect(fired, 'no webhook for a removal that removed nothing').toBe(0)
    // … but the ledger stays true: an EE audit chain is hash-linked, so a line here is a permanent lie.
    expect(await auditRows() - before, 'no audit line either').toBe(0)
    await deleteTuples(fgaClient, memberTuples(TENANT, [grantee.slice('user:'.length)])).catch(() => {})
  }, 120_000)

  it('a store that refuses the delete is still heard — no forgiveness on the way back in', async () => {
    // The regression this whole re-review is about was a `.catch()` that turned a refusal into success.
    // Nothing about "read first" prevents someone re-adding one, so the refusal is measured directly:
    // a client whose write is refused must surface, not answer 200 with the leaf still in place.
    const grantee = `user:rlp619-refuse-${STAMP}`
    await ensureMembers(TENANT, [grantee.slice('user:'.length)])
    await writeTuples(fgaClient, SPACE_GRANT_RELATIONS.view.map((relation) => ({ user: grantee, relation, object: `space:${spaceId}` })))
    const refusing = Object.assign(Object.create(Object.getPrototypeOf(fgaClient) as object), fgaClient, {
      write: async () => { throw new Error('the permission store is unavailable') },
    }) as typeof fgaClient

    await expect(revokeSpaceAccess(db, refusing, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee, capability: 'view', plan: 'business',
    }), 'a refused delete must not be reported as a revoke').rejects.toThrow()
    expect(await heldFor(grantee), 'and the access is still there, honestly').toEqual(new Set(SPACE_GRANT_RELATIONS.view))

    await deleteTuples(fgaClient, SPACE_GRANT_RELATIONS.view.map((relation) => ({ user: grantee, relation, object: `space:${spaceId}` }))).catch(() => {})
    await deleteTuples(fgaClient, memberTuples(TENANT, [grantee.slice('user:'.length)])).catch(() => {})
  }, 120_000)

  it('a real removal DOES get its line and its event (the honesty rule cuts both ways)', async () => {
    const grantee = `user:rlp619-real-${STAMP}`
    await ensureMembers(TENANT, [grantee.slice('user:'.length)])
    await writeTuples(fgaClient, SPACE_GRANT_RELATIONS.view.map((relation) => ({ user: grantee, relation, object: `space:${spaceId}` })))

    const before = await auditRows()
    const fired = await firedRevokes(() => revoke(grantee, 'view'))

    expect(fired, 'the access really went, so the event fires').toBe(1)
    expect(await auditRows() - before, 'and the ledger records it').toBe(1)
    expect(await heldFor(grantee)).toEqual(new Set())
    await deleteTuples(fgaClient, memberTuples(TENANT, [grantee.slice('user:'.length)])).catch(() => {})
  }, 120_000)
})
