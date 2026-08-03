// #568 / ADR-198 §1: the credentials table's own guarantees, measured against a real Postgres.
//
// These are properties of the DATA, not of the code that writes it, and each one closes a specific
// hole: a credential must not outlive its member (or a removed person keeps a way in), a re-invite of
// the same address must not be blocked forever by a dormant row, a password belongs to a member of THIS
// tenant, and one tenant must never read another's hashes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { hashPassword } from '../auth/password-hash.js'
import { enrolUnderSeatCap } from '../auth/invites.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)

let app: FastifyInstance
let db: TenantDb
let other: TenantDb
const subs: string[] = []

// A local member: the sub carries the reserved prefix this product mints (#569).
const localSub = (n: string) => { const s = `wlocal_lc568-${n}-${STAMP}`; subs.push(s); return s }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  other = await acquireTenantDb(asTenant(OTHER))
}, 120_000)

afterAll(async () => {
  for (const s of subs) {
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${s}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${s}`.catch(() => {})
  }
  await db.release(); await other.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

async function seatLocalMember(sub: string, email: string): Promise<void> {
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub, email }, 'member', 'invite', 'local'))
}
const putCredential = (sub: string, identifier: string, hash: string) =>
  db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
         VALUES (${TENANT}, ${sub}, ${identifier}, ${hash})`

describe('#568 §1: a password cannot outlive, escape, or be spoofed into its member', () => {
  it('a credential belongs to a member, and dies with the member row', async () => {
    const sub = localSub('cascade')
    await seatLocalMember(sub, `${sub}@e2e.test`)
    await putCredential(sub, `${sub}@e2e.test`, await hashPassword('pw'))
    expect((await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${sub}`).length).toBe(1)

    await db.sql`DELETE FROM members WHERE sub = ${sub}`
    expect((await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${sub}`).length,
      'the FK cascade takes the credential with the member').toBe(0)
  }, 120_000)

  it('a credential cannot be written for a member who does not exist', async () => {
    // Otherwise a password could be planted ahead of (or after) a membership decision.
    const sub = localSub('orphan')
    await expect(putCredential(sub, `${sub}@e2e.test`, await hashPassword('pw'))).rejects.toThrow()
  }, 120_000)

  // #606 / ADR-205 §2 (ruled A, 2026-08-04): this used to assert the opposite — the table refused a
  // credential for any subject that was not `wlocal_`. That rule described what the product happened to
  // allow (a password only ever arrived by minting one), not what it must forbid, and it made the ruled
  // feature impossible: an SSO tenant's members are ALL IdP-derived, so "give this member a password
  // entrance too" could never be given to the people who need it (#605's break-glass).
  //
  // What the CHECK was protecting is still protected, one layer up: an external IdP may not ASSERT a
  // reserved subject (#569/#592), so an IdP-derived member's sub is one this product wrote down for them.
  // Both halves are measured here — the credential attaches, and the assertion is still refused.
  it('an IdP-derived member may hold a password — and an IdP still cannot assert a reserved sub', async () => {
    const foreign = `oidc-sub-lc568-${STAMP}`
    subs.push(foreign)
    await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub: foreign, email: `${foreign}@e2e.test` }, 'member', 'invite'))
    await putCredential(foreign, `${foreign}@e2e.test`, await hashPassword('pw'))
    expect((await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${foreign}`).length,
      'the password attaches to the sub the member already has — nobody is duplicated').toBe(1)

    const { externalSubViolation } = await import('../auth/reserved-subs.js')
    expect(externalSubViolation(`wlocal_${STAMP}`),
      'the spoof the dropped CHECK was standing in for is refused where it arrives').toBeTruthy()
    expect(externalSubViolation(foreign), 'an ordinary external subject is untouched').toBeFalsy()
  }, 120_000)

  it('one identifier per tenant — and removing the member frees it again (M4)', async () => {
    const first = localSub('ident-a')
    const second = localSub('ident-b')
    const shared = `reused-${STAMP}@e2e.test`
    await seatLocalMember(first, shared)
    await putCredential(first, shared, await hashPassword('pw'))

    await seatLocalMember(second, shared)
    await expect(putCredential(second, shared, await hashPassword('pw')), 'two live members cannot share a login name')
      .rejects.toThrow()

    // The M4 defect: if removal left the row behind, this address could never be invited again.
    await db.sql`DELETE FROM local_credentials WHERE member_sub = ${first}`
    await db.sql`DELETE FROM members WHERE sub = ${first}`
    await putCredential(second, shared, await hashPassword('pw'))
    expect((await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${second}`).length).toBe(1)
  }, 120_000)

  it('a tenant cannot read (or delete) another tenant\'s hashes', async () => {
    const sub = localSub('rls')
    await seatLocalMember(sub, `${sub}@e2e.test`)
    await putCredential(sub, `${sub}@e2e.test`, await hashPassword('pw'))
    // FORCE RLS: the other tenant's handle sees nothing, and its delete touches nothing.
    expect((await other.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${sub}`).length).toBe(0)
    await other.sql`DELETE FROM local_credentials WHERE member_sub = ${sub}`
    expect((await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${sub}`).length,
      'still here — the cross-tenant delete was a no-op, not a success').toBe(1)
  }, 120_000)

  it('enrolment records WHO issued the identity, and defaults to oidc for every existing caller', async () => {
    const local = localSub('src-local')
    const oidc = `oidc-src-lc568-${STAMP}`
    subs.push(oidc)
    await seatLocalMember(local, `${local}@e2e.test`)
    await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub: oidc, email: `${oidc}@e2e.test` }, 'member', 'auto'))
    const [l] = await db.sql<[{ identity_source: string }]>`SELECT identity_source FROM members WHERE sub = ${local}`
    const [o] = await db.sql<[{ identity_source: string }]>`SELECT identity_source FROM members WHERE sub = ${oidc}`
    expect(l.identity_source).toBe('local')
    expect(o.identity_source, 'the default keeps every pre-#568 caller unchanged').toBe('oidc')
  }, 120_000)
})
