// #858 / #949, ADR-259 §3.9: `DELETE /members/:sub/password-setup` used to ask `identity_source ===
// 'local'` as a proxy for "this is this member's only door". A link breaks that proxy in both
// directions — password-entrance-removal-626.test.ts already covers the LINK case (a `local` member
// who has since linked a provider may have their password removed). This file covers the other two
// inputs `memberHasAnotherWayIn` (auth/login-methods.ts) reads: a still-effective connection whose
// prefix this member's sub carries, and the same sub once that connection is gone.
//
// review the console read `identity_source` directly instead of this predicate, so the
// three fixtures below also pin `GET /members`'s `has_another_way_in` field — the SAME shapes, checked
// through the LIST route the console actually reads from.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import { subjectPrefixFor } from '../routes/admin-connections.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let app: FastifyInstance
let tenant: PrivateTenant

const giveCredential = (sub: string) =>
  admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
        VALUES (${tenant.id}, ${sub}, ${`${sub}@t949.test`}, 'x')
        ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = 'x'`
const credentialCount = async (sub: string) =>
  Number((await admin<{ n: string }[]>`
    SELECT count(*)::text AS n FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`)[0]!.n)
const remove = (sub: string) =>
  app.inject({ method: 'DELETE', url: `/members/${sub}/password-setup`, headers: tenant.AUTH })
const hasAnotherWayIn = async (sub: string): Promise<boolean | undefined> => {
  const res = await app.inject({ method: 'GET', url: `/members?q=${sub}`, headers: tenant.AUTH })
  const body = res.json() as { members: { sub: string; has_another_way_in?: boolean }[] }
  return body.members.find((m) => m.sub === sub)?.has_another_way_in
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = await privateTenant(admin, `t949-${STAMP}`)
}, 60_000)

afterAll(async () => {
  await tenant?.dispose()
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('#949: the mint-derived input — a still-effective connection prefix', () => {
  it('a member seated by a still-effective connection may have their password removed (#626)', async () => {
    const connId = `11111111-1111-1111-1111-${STAMP.padStart(12, '0')}`
    const prefix = subjectPrefixFor(connId)
    const sub = `${prefix}holder1`
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, subject_prefix)
                VALUES (${connId}, ${tenant.id}, 'https://idp.t949.test', 'c', 'https://t949.test/auth/callback', TRUE, ${prefix})`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t949.test`}, 'member')`
    await giveCredential(sub)
    try {
      expect(await hasAnotherWayIn(sub), 'GET /members must agree with what DELETE is about to allow').toBe(true)
      const res = await remove(sub)
      expect(res.statusCode, res.body).toBe(200)
      expect(await credentialCount(sub)).toBe(0)
    } finally {
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${connId}`.catch(() => {})
    }
  })

  it('the SAME sub, once that connection is deleted, may NOT — no link, no other credential (#949)', async () => {
    // The fixture states the sub's SHAPE (§5): it carries a connection's prefix, but that connection
    // no longer resolves — this is the case `identity_source` could never see, because the column
    // never recorded which connection a member arrived through.
    const connId = `22222222-2222-2222-2222-${STAMP.padStart(12, '0')}`
    const prefix = subjectPrefixFor(connId)
    const sub = `${prefix}holder2`
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, subject_prefix)
                VALUES (${connId}, ${tenant.id}, 'https://idp.t949.test', 'c', 'https://t949.test/auth/callback', TRUE, ${prefix})`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t949.test`}, 'member')`
    await giveCredential(sub)
    // The connection is removed — admin-connections.ts's only `DELETE FROM tenant_oidc`, reproduced here.
    await admin`DELETE FROM tenant_oidc WHERE id = ${connId}`
    try {
      expect(await hasAnotherWayIn(sub), 'GET /members must agree with the 409 DELETE is about to return').toBe(false)
      const res = await remove(sub)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'last_way_in' })
      expect(await credentialCount(sub), 'nothing was removed').toBe(1)
    } finally {
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
    }
  })
})

describe('#949: the link input, isolated from the mint-derived one', () => {
  it('a member holding a link but no still-effective connection prefix may have their password removed', async () => {
    const sub = `t949-linked-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t949.test`}, 'member')`
    await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
                VALUES (${tenant.id}, ${`t949-conn-${STAMP}`}, ${`t949-ext-${STAMP}`}, ${sub})`
    await giveCredential(sub)
    try {
      expect(await hasAnotherWayIn(sub), 'a link alone must already read as another way in').toBe(true)
      const res = await remove(sub)
      expect(res.statusCode, res.body).toBe(200)
    } finally {
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
    }
  })
})
