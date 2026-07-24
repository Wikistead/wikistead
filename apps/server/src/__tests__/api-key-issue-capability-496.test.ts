// #496 / ADR-181: who may MINT an API key is a tenant ROLE CAPABILITY (`issueApiKeys` → the
// `api_key_issue` FGA relation), replacing #462's `api_key_issue_policy` enum. This file REPLACES
// api-key-policy-462.test.ts: its `members` / `admins_only` cases live on below as the migration
// EQUIVALENCE pins (the member userset tuple is what `members` became; its absence is `admins_only`),
// and its still-valid "whose keys can a caller see" half is carried over unchanged.
//
// Authorization boundary, so these are mandatory. Real Postgres + real OpenFGA, driven over HTTP.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples, writeTuples } from '@wikistead/authz'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const MEMBER = 'akp496-member'
const OTHER = 'akp496-other'

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
const sids: Record<string, string> = {}

const H = (who: 'admin' | 'member' | 'other') =>
  who === 'admin'
    ? { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    : { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sids[who]}` }

const mint = (who: 'admin' | 'member' | 'other', name: string) =>
  app.inject({ method: 'POST', url: '/api-keys', headers: H(who), payload: { name } })

// The two ways a member ends up able to issue, as the server itself writes them (ADR §2).
const memberUserset = () => ({ user: `tenant:${tenant.id}#member`, relation: 'api_key_issue', object: `tenant:${tenant.id}` })
// What a custom TENANT-scope role bundling `issueApiKeys` expands to for one person (roles.ts
// expansionTuples) — written directly here so the pin covers the gate, not the role plumbing.
const userLeaf = (sub: string) => ({ user: `user:${sub}`, relation: 'api_key_issue', object: `tenant:${tenant.id}` })

// The member toggle through its real endpoint (the Roles tab's built-in `member` capability).
const setMemberToggle = (on: boolean, who: 'admin' | 'member' = 'admin') =>
  app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H(who), payload: { memberIssueApiKeys: on } })

// Delete each tuple in its OWN call: an FGA write is atomic, so batching three deletes means one absent
// tuple aborts the whole batch and silently leaves the others in place (which made a later test see a
// stale grant). Per-tuple + catch = idempotent teardown whatever the previous test left behind.
async function clearIssuance() {
  for (const t of [memberUserset(), userLeaf(MEMBER), userLeaf(OTHER)]) {
    await deleteTuples(fgaClient, [t]).catch(() => {})
  }
}
// Idempotent grant for the same reason (re-writing an existing tuple is an FGA error, not a no-op).
async function grant(tuple: { user: string; relation: string; object: string }) {
  await writeTuples(fgaClient, [tuple]).catch(() => {})
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await ensureMembers(tenant.id, [MEMBER, OTHER])
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenant.id}, ${MEMBER}, 'member'), (${tenant.id}, ${OTHER}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
  for (const who of ['member', 'other'] as const) {
    sids[who] = await createSession(valkey, { tenantId: tenant.id, sub: who === 'member' ? MEMBER : OTHER, role: 'member' })
  }
}, 40_000)

afterAll(async () => {
  await clearIssuance()
  await admin`DELETE FROM api_keys WHERE tenant_id = ${tenant.id} AND owner_user_id IN (${MEMBER}, ${OTHER})`
  await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub IN (${MEMBER}, ${OTHER})`
  await deleteTuples(fgaClient, memberTuples(tenant.id, [MEMBER, OTHER])).catch(() => {})
  await db.release()
  await app.close()
  await valkey.quit()
  await admin.end()
  await pool.end()
})

// Every case starts from the model's DEFAULT: no member userset, no user leaf → admins only.
beforeEach(clearIssuance)

describe('#496: the issue capability is the gate', () => {
  it('default is admin-only — a member is refused AND nothing is written; an admin still issues', async () => {
    const refused = await mint('member', 'akp496-should-not-exist')
    expect(refused.statusCode, 'no capability → refused at the server, not by hiding a button').toBe(403)
    expect((refused.json() as { code?: string }).code, 'the console is told WHY (#445)').toBe('api_key_issue')
    const rows = await admin`SELECT id FROM api_keys WHERE tenant_id = ${tenant.id} AND name = 'akp496-should-not-exist'`
    expect(rows.length, 'a refused mint leaves no key row behind').toBe(0)

    expect((await mint('admin', 'akp496-admin-key')).statusCode, "the model's `or admin` arm").toBe(201)
  })

  it('the member toggle opts every member in, and back out — the tuple is the authority', async () => {
    expect((await setMemberToggle(true)).statusCode).toBe(200)
    expect((await mint('member', 'akp496-toggled-on')).statusCode).toBe(201)
    expect((await mint('other', 'akp496-toggled-on-other')).statusCode, 'it is a MEMBER userset, not one person').toBe(201)

    expect((await setMemberToggle(false)).statusCode).toBe(200)
    expect((await mint('member', 'akp496-toggled-off')).statusCode, 'live — no cached flag').toBe(403)
  })

  it('a specific member (what a custom tenant role expands to) issues; their peer does not', async () => {
    await grant(userLeaf(MEMBER))
    expect((await mint('member', 'akp496-granted')).statusCode).toBe(201)
    expect((await mint('other', 'akp496-not-granted')).statusCode, 'the grant names one person').toBe(403)

    await deleteTuples(fgaClient, [userLeaf(MEMBER)]) // unassigning the role / dropping the capability
    expect((await mint('member', 'akp496-revoked')).statusCode, 'revocation is live').toBe(403)
  })

  it('only an admin may flip the member toggle — no self-grant path', async () => {
    expect((await setMemberToggle(true, 'member')).statusCode, 'a member cannot grant themselves issuance').toBe(403)
    expect((await mint('member', 'akp496-self-granted')).statusCode, 'and is still refused').toBe(403)
  })

  // The member toggle endpoint carries TWO capabilities now (#445's createSpaces + this one). A patch that
  // names one must not disturb the other — #445's toggle is a shipped authz control and this is the change
  // that could have clobbered it.
  it('flipping one member toggle leaves the other exactly as it was', async () => {
    const read = async () => (await app.inject({ method: 'GET', url: '/admin/roles/tenant-defaults', headers: H('admin') }))
      .json() as { member: { createSpaces: boolean; issueApiKeys: boolean } }
    const before = await read()

    expect((await setMemberToggle(true)).statusCode).toBe(200)
    expect((await read()).member.createSpaces, "issueApiKeys:true must not touch createSpaces").toBe(before.member.createSpaces)

    const flipCreate = await app.inject({
      method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H('admin'),
      payload: { memberCreateSpaces: !before.member.createSpaces },
    })
    expect(flipCreate.statusCode).toBe(200)
    expect((await read()).member.issueApiKeys, 'and the reverse holds too').toBe(true)

    // restore createSpaces so a later suite sees the tenant it expects
    await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H('admin'), payload: { memberCreateSpaces: before.member.createSpaces } })
  })

  it('rejects a body that names neither toggle, and a non-boolean', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H('admin'), payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H('admin'), payload: { memberIssueApiKeys: 'yes' } })).statusCode).toBe(400)
  })

  it('reports to the caller whether THEY may issue, matching the gate exactly', async () => {
    const canIssue = async (who: 'admin' | 'member') =>
      ((await app.inject({ method: 'GET', url: '/api-keys/policy', headers: H(who) })).json() as { canIssue: boolean }).canIssue
    expect(await canIssue('member'), 'default admin-only').toBe(false)
    expect(await canIssue('admin')).toBe(true)

    await setMemberToggle(true)
    expect(await canIssue('member'), 'and it follows the tuple, like the gate does').toBe(true)
  })
})

// #462 → #496 migration equivalence: the enum's two shapes must behave EXACTLY as before, now expressed
// as tuples. `members` (and NULL, its default) mapped to the member userset; `admins_only` to no tuple.
describe('#496: migration equivalence with the retired #462 policy enum', () => {
  it("a tenant that was 'members' (incl. the NULL default) behaves the same — every member issues", async () => {
    await grant(memberUserset()) // what migrate-496 writes for 'members' / NULL
    expect((await mint('member', 'akp496-equiv-members')).statusCode).toBe(201)
    expect((await mint('admin', 'akp496-equiv-members-admin')).statusCode).toBe(201)
  })

  it("a tenant that was 'admins_only' behaves the same — member refused, admin issues", async () => {
    // migrate-496 writes NOTHING for 'admins_only'; `or admin` carries the admin.
    expect((await mint('member', 'akp496-equiv-admins')).statusCode).toBe(403)
    expect((await mint('admin', 'akp496-equiv-admins-admin')).statusCode).toBe(201)
  })

  it('the retired enum column is gone — no settings row can re-introduce a second authority', async () => {
    const [col] = await admin<{ n: string }[]>`
      SELECT column_name AS n FROM information_schema.columns
      WHERE table_name = 'tenant_settings' AND column_name = 'api_key_issue_policy'`
    expect(col, 'migration 084 dropped it (ADR-181 §2: one authority)').toBeUndefined()
  })
})

// Carried over from #462 unchanged — about who can SEE which keys, not who may mint them.
describe('#496 (was #462): whose keys a caller can see', () => {
  it("shows a member their own keys and nobody else's", async () => {
    await grant(memberUserset())
    await mint('member', 'mine-496')
    await mint('other', 'theirs-496')

    const mine = (await app.inject({ method: 'GET', url: '/api-keys/mine', headers: H('member') })).json() as { name: string }[]
    const names = mine.map((k) => k.name)
    expect(names).toContain('mine-496')
    expect(names, "another member's integration is not this member's business").not.toContain('theirs-496')
  })

  it('keeps the tenant-wide list to admins — it maps out who automates what', async () => {
    await grant(memberUserset())
    await mint('member', 'mine-496b')
    const asMember = await app.inject({ method: 'GET', url: '/api-keys', headers: H('member') })
    expect(asMember.statusCode, 'every member could read this before #462').toBe(403)

    const asAdmin = await app.inject({ method: 'GET', url: '/api-keys', headers: H('admin') })
    expect(asAdmin.statusCode).toBe(200)
    expect((asAdmin.json() as { name: string }[]).map((k) => k.name)).toEqual(expect.arrayContaining(['mine-496b']))
  })

  it('still lets only the owner revoke a key', async () => {
    await grant(memberUserset())
    const created = (await mint('member', 'revoke-496')).json() as { id: string }
    const byOther = await app.inject({ method: 'DELETE', url: `/api-keys/${created.id}`, headers: H('other') })
    expect(byOther.statusCode, 'not yours to revoke — and the 404 does not confirm it exists').toBe(404)
    const byOwner = await app.inject({ method: 'DELETE', url: `/api-keys/${created.id}`, headers: H('member') })
    expect(byOwner.statusCode).toBe(204)
  })
})
