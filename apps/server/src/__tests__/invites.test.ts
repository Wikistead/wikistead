// Integration tests — real Postgres + real OpenFGA, no mocks. Covers the invite
// token discipline (consume-once, tenant-bound, role-bound, revocable, expiry) and
// the ADR-003 rollback of acceptInvite. Seat enforcement + the admin routes are
// tested separately (seat: seats.test; routes: members.test).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import type { Tenant } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { createInvite, acceptInvite, revokeInvite, hashInviteToken } from '../auth/invites.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const created: string[] = []

const hasRel = async (user: string, relation: string, object: string) =>
  Boolean((await fgaClient.check({ user, relation, object })).allowed)

const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

// FGA proxy that throws on write — to prove acceptInvite rolls the DB back when
// the FGA grant (written LAST, per ADR-003) fails.
function fgaFailingWrite(): OpenFgaClient {
  return new Proxy(fgaClient, {
    get(t, p, r) {
      if (p === 'write') return async () => { throw new Error('injected FGA write failure') }
      const v = Reflect.get(t, p, r)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  }) as OpenFgaClient
}

let tenantId: string
let db: TenantDb

beforeAll(async () => {
  const { tenantId: id } = await provisionTenant(fgaClient, {
    slug: `p14inv-${Date.now().toString(36)}`,
    admin: { sub: 'owner-1', email: 'owner@x.test' },
  })
  tenantId = id
  created.push(id)
  db = await acquireTenantDb(asTenant(id))
})

afterAll(async () => {
  await db.release().catch(() => {})
  for (const id of created) {
    await admin`DELETE FROM invites WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${id}`.catch(() => {})
  }
  await admin.end()
  await pool.end()
})

const memberCount = async (sub: string) =>
  Number((await admin`SELECT count(*)::int AS n FROM members WHERE tenant_id = ${tenantId} AND sub = ${sub}`)[0]!.n)

describe('acceptInvite — happy path + role', () => {
  it('grants membership once: member row (role) + FGA tuples', async () => {
    const { token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: 'a@x.test', role: 'member' })
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'invitee-a', email: 'a@x.test' })).toBe(true)

    const [m] = await admin`SELECT role FROM members WHERE tenant_id = ${tenantId} AND sub = 'invitee-a'`
    expect(m).toMatchObject({ role: 'member' })
    expect(await hasRel('user:invitee-a', 'member', `tenant:${tenantId}`)).toBe(true)
    expect(await hasRel('user:invitee-a', 'admin', `tenant:${tenantId}`)).toBe(false)
    await deleteTuples(fgaClient, [{ user: 'user:invitee-a', relation: 'member', object: `tenant:${tenantId}` }])
  })

  it('an admin-role invite also grants the FGA admin tuple', async () => {
    const { token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: null, role: 'admin' })
    // #930 / ADR-263 §3.1: a seat requires an address — the OIDC claims carry it here, unrelated to
    // what this test is actually about (the admin FGA tuple), so it must not go missing.
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'invitee-adm', email: 'invitee-adm@x.test' })).toBe(true)
    expect(await hasRel('user:invitee-adm', 'admin', `tenant:${tenantId}`)).toBe(true)
    await deleteTuples(fgaClient, [
      { user: 'user:invitee-adm', relation: 'member', object: `tenant:${tenantId}` },
      { user: 'user:invitee-adm', relation: 'admin', object: `tenant:${tenantId}` },
    ])
  })
})

describe('acceptInvite — consume-once / revoke / expiry / tampering', () => {
  it('rejects a second use of the same token (consume-once)', async () => {
    const { token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: null, role: 'member' })
    // #930 / ADR-263 §3.1: a seat requires an address — unrelated to what this test is about
    // (consume-once), so the first, successful accept must carry one.
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'once-1', email: 'once-1@x.test' })).toBe(true)
    // Second accept by a DIFFERENT identity must fail — and create no member.
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'once-2' })).toBe(false)
    expect(await memberCount('once-2')).toBe(0)
    await deleteTuples(fgaClient, [{ user: 'user:once-1', relation: 'member', object: `tenant:${tenantId}` }])
  })

  it('rejects a revoked invite', async () => {
    const { id, token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: null, role: 'member' })
    expect(await revokeInvite(db, id)).toBe(true)
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'revoked-1' })).toBe(false)
    expect(await memberCount('revoked-1')).toBe(0)
  })

  it('rejects an expired invite', async () => {
    const token = 'inv_expired_fixture'
    await admin`
      INSERT INTO invites (tenant_id, token_hash, role, invited_by, status, expires_at)
      VALUES (${tenantId}, ${hashInviteToken(token)}, 'member', 'owner-1', 'pending', now() - interval '1 hour')`
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), token, { sub: 'exp-1' })).toBe(false)
    expect(await memberCount('exp-1')).toBe(0)
  })

  it('rejects an unknown / tampered token', async () => {
    expect(await acceptInvite({ db, fga: fgaClient }, asTenant(tenantId), 'inv_never_issued', { sub: 'bogus-1' })).toBe(false)
    expect(await memberCount('bogus-1')).toBe(0)
  })
})

describe('acceptInvite — tenant isolation (cannot cross tenants)', () => {
  it('an invite issued for tenant A cannot be accepted under tenant B', async () => {
    const { tenantId: bId } = await provisionTenant(fgaClient, {
      slug: `p14inv-b-${Date.now().toString(36)}`,
      admin: { sub: 'owner-b' },
    })
    created.push(bId)
    const dbB = await acquireTenantDb(asTenant(bId))
    try {
      const { token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: null, role: 'member' })
      // Same plaintext token, but resolved under tenant B → tenant-bound check + RLS both reject.
      expect(await acceptInvite({ db: dbB, fga: fgaClient }, asTenant(bId), token, { sub: 'cross-1' })).toBe(false)
      expect(Number((await admin`SELECT count(*)::int AS n FROM members WHERE tenant_id = ${bId} AND sub = 'cross-1'`)[0]!.n)).toBe(0)
      // The A-side invite is untouched (still pending) — usable by the real invitee.
      const [inv] = await admin`SELECT status FROM invites WHERE tenant_id = ${tenantId} AND token_hash = ${hashInviteToken(token)}`
      expect(inv).toMatchObject({ status: 'pending' })
    } finally {
      await dbB.release()
    }
  })
})

describe('acceptInvite — ADR-003 rollback', () => {
  it('a FGA write failure rolls back the member row AND the invite flip', async () => {
    const { id, token } = await createInvite(db, { tenantId, plan: 'free', invitedBy: 'owner-1', email: null, role: 'member' })
    // #930 / ADR-263 §3.1: must clear the email-required floor to reach the FGA write this test
    // actually injects a failure into.
    await expect(
      acceptInvite({ db, fga: fgaFailingWrite() }, asTenant(tenantId), token, { sub: 'rollback-1', email: 'rollback-1@x.test' }),
    ).rejects.toThrow(/injected FGA write failure/)
    // No half-member: no member row, and the invite is STILL pending (flip undone).
    expect(await memberCount('rollback-1')).toBe(0)
    const [inv] = await admin`SELECT status FROM invites WHERE id = ${id}`
    expect(inv).toMatchObject({ status: 'pending' })
    // FGA must not have granted membership either.
    expect(await hasRel('user:rollback-1', 'member', `tenant:${tenantId}`)).toBe(false)
  })
})
