// #858 / #962, ADR-259 §3.8: `members.groups` used to be OVERWRITTEN wholesale by every login upsert —
// harmless with one way in, but ADR-259 §3.1-3.3 made a second connection a real, reachable state, and
// its login (asserting fewer or different groups) silently erased the first connection's grant. This
// pins the fix: each connection keeps its own slice (`member_connection_groups`), `members.groups` is
// the union of every slice a member holds, and a trust_groups revocation drops its slice's contribution
// immediately — not at the member's next login through some OTHER, still-trusted connection.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import IORedis from 'ioredis'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'
import { buildApp } from '../app.js'
import type { FastifyInstance } from 'fastify'
import { establishMemberSession } from '../auth/session.js'
import { groupFgaId, revokeConnectionGroups } from '../auth/group-sync.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let tenant: PrivateTenant
let db: TenantDb
let app: FastifyInstance

const asTenant = (t: PrivateTenant): Tenant => ({ id: t.id, slug: t.slug, plan: 'business', isolation: 'logical' }) as Tenant
const deps = () => ({ db, fga: fgaClient, valkey })
const MEMBER = `g962-member-${STAMP}`
const CONN_A = `conn-a-${STAMP}`
const CONN_B = `conn-b-${STAMP}`
const ENG = `g962-eng-${STAMP}`
const SALES = `g962-sales-${STAMP}`

const inGroup = async (sub: string, g: string) =>
  (await fgaClient.check({ user: `user:${sub}`, relation: 'member', object: `group:${groupFgaId(tenant.id, g)}` })).allowed === true
const groupsOf = async (sub: string): Promise<string[]> => {
  const [row] = await admin<{ groups: string[] }[]>`SELECT groups FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`
  return [...(row?.groups ?? [])].sort()
}
const loginVia = (connectionId: string, groups: string[]) =>
  establishMemberSession(deps(), asTenant(tenant), { sub: MEMBER, groups }, { subMintedInternally: true, door: 'federated', connectionId })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = await privateTenant(admin, `g962-${STAMP}`)
  db = await acquireTenantDb(asTenant(tenant))
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${MEMBER}, ${`${MEMBER}@g962.test`}, 'member')`
  const { writeTuples } = await import('@wikistead/authz')
  await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }])
}, 60_000)

afterAll(async () => {
  await tenant?.dispose()
  await db?.release(); await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('#962: members.groups is the UNION across connections, not the last login\'s claim', () => {
  it('a second connection asserting fewer/different groups does not erase the first\'s', async () => {
    await loginVia(CONN_A, [ENG])
    expect(await groupsOf(MEMBER)).toEqual([ENG])
    expect(await inGroup(MEMBER, ENG)).toBe(true)

    // B asserts a DIFFERENT group and nothing about ENG — the union keeps BOTH.
    await loginVia(CONN_B, [SALES])
    expect(await groupsOf(MEMBER)).toEqual([ENG, SALES].sort())
    expect(await inGroup(MEMBER, ENG), 'A\'s grant must survive B\'s login').toBe(true)
    expect(await inGroup(MEMBER, SALES)).toBe(true)
  });

  it('the directory removing a group from one connection\'s claim drops it from the union at that connection\'s NEXT login, leaving the other connection\'s slice untouched', async () => {
    // A no longer asserts ENG (the directory removed the member from it) — SALES (B's slice) survives.
    await loginVia(CONN_A, []);
    expect(await groupsOf(MEMBER)).toEqual([SALES]);
    expect(await inGroup(MEMBER, ENG), 'ENG must leave the union once nobody asserts it').toBe(false);
    expect(await inGroup(MEMBER, SALES), 'SALES is unrelated to A\'s claim and must survive').toBe(true);
  });

  it('revoking a connection\'s trust_groups removes its contribution IMMEDIATELY — not at the member\'s next login through a different, still-trusted connection', async () => {
    // Re-assert ENG via A so there is something for B's revoke to leave untouched, and something
    // for A's own continued trust to keep holding.
    await loginVia(CONN_A, [ENG]);
    expect(await groupsOf(MEMBER)).toEqual([ENG, SALES].sort());

    // This is the function PATCH /admin/connections/:id calls when trust_groups flips true → false —
    // called here directly, with NO further login, matching the acceptance criterion's own wording.
    await revokeConnectionGroups(db.sql, fgaClient, tenant.id, CONN_B);
    expect(await groupsOf(MEMBER)).toEqual([ENG]);
    expect(await inGroup(MEMBER, SALES), 'B\'s revoke must clear SALES without a login').toBe(false);
    expect(await inGroup(MEMBER, ENG), 'A was never revoked — its grant must survive').toBe(true);
  });
});

describe('#962: PATCH /admin/connections/:id revokes trust_groups end-to-end', () => {
  const SUB = `g962-patch-member-${STAMP}`
  const GROUP = `g962-patch-grp-${STAMP}`
  let ptenant: PrivateTenant
  let pdb: TenantDb
  let connId: string

  beforeAll(async () => {
    ptenant = await privateTenant(admin, `g962patch-${STAMP}`)
    pdb = await acquireTenantDb({ id: ptenant.id, slug: ptenant.slug, plan: 'business', isolation: 'logical' } as Tenant)
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${ptenant.id}, ${SUB}, ${`${SUB}@g962p.test`}, 'member')`
    const { writeTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, [{ user: `user:${SUB}`, relation: 'member', object: `tenant:${ptenant.id}` }])
    const id = randomUUID()
    // #798: a preset-less connection needs a LABEL (what the sign-in screen calls it) — the PATCH
    // route refuses without one, same rule the create route enforces.
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, trust_groups, label)
                VALUES (${id}, ${ptenant.id}, 'https://idp.g962patch.test', 'c', 'https://g962patch.test/auth/callback', TRUE, TRUE, 'g962 test IdP')`
    connId = id
    await establishMemberSession(
      { db: pdb, fga: fgaClient, valkey },
      { id: ptenant.id, plan: 'business' },
      { sub: SUB, groups: [GROUP] },
      { subMintedInternally: true, door: 'federated', connectionId: connId },
    )
  }, 60_000)

  afterAll(async () => { await ptenant?.dispose(); await pdb?.release() }, 60_000)

  it('flipping trustGroups to false via the admin route clears the group immediately', async () => {
    expect((await admin<{ groups: string[] }[]>`SELECT groups FROM members WHERE tenant_id = ${ptenant.id} AND sub = ${SUB}`)[0]?.groups)
      .toEqual([GROUP])
    expect((await fgaClient.check({ user: `user:${SUB}`, relation: 'member', object: `group:${groupFgaId(ptenant.id, GROUP)}` })).allowed).toBe(true)

    const res = await app.inject({
      method: 'PATCH', url: `/admin/connections/${connId}`, headers: ptenant.H,
      payload: { trustGroups: false },
    })
    expect(res.statusCode, res.body).toBe(204)

    expect((await admin<{ groups: string[] }[]>`SELECT groups FROM members WHERE tenant_id = ${ptenant.id} AND sub = ${SUB}`)[0]?.groups)
      .toEqual([])
    expect((await fgaClient.check({ user: `user:${SUB}`, relation: 'member', object: `group:${groupFgaId(ptenant.id, GROUP)}` })).allowed, 'no second login happened — the PATCH alone must clear it').toBe(false)
  });
});
