// #858 / #960, ADR-259 §3.5: a connection's deletion takes its links with it, ATOMICALLY, and asks —
// in ADR-251's vocabulary — before it strands a member who has no other way in.
//
// `connection_id` carries no foreign key (§3.9: its domain spans two tables plus two literals, which
// Postgres cannot express as one column's constraint), so nothing but the route's own transaction stops
// a link from outliving the connection it named. The atomicity pin below is ADR-259 §5's own: the
// minimal correct implementation (delete links, delete connection, in one transaction) has no statement
// AFTER the second delete for a fixture to fail — so the seam is a DEFERRABLE INITIALLY DEFERRED
// constraint trigger, created here, that raises unconditionally at COMMIT. An atomic implementation
// reaches commit, the trigger fires, and the whole transaction rolls back: both rows survive, green.
// Two statements with no transaction between them have each already committed: red.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import { subjectPrefixFor } from '../routes/admin-connections.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let app: FastifyInstance
let tenant: PrivateTenant

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = await privateTenant(admin, `t960-${STAMP}`)
  // The WORKSPACE-level guard (`assertClosingIsSafe`) runs before this ticket's per-member one, and
  // `privateTenant` seats `dev-user` as admin with no credential — so `local` counts as unusable
  // (`anAdminHoldsAKey`) and every connection in this tenant is already its only effective door. Giving
  // the admin a password is what lets a test connection's deletion reach the check this file is about.
  await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
              VALUES (${tenant.id}, 'dev-user', ${`dev-user@t960.test`}, 'x')`
}, 60_000)

afterAll(async () => {
  await tenant?.dispose()
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

const makeConnection = async (): Promise<{ id: string; prefix: string }> => {
  const id = randomUUID()
  const prefix = subjectPrefixFor(id)
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, subject_prefix)
              VALUES (${id}, ${tenant.id}, 'https://idp.t960.test', 'c', 'https://t960.test/auth/callback', TRUE, ${prefix})`
  return { id, prefix }
}
const linkCount = async (connId: string) =>
  Number((await admin<{ n: string }[]>`SELECT count(*)::text AS n FROM member_identities WHERE connection_id = ${connId}`)[0]!.n)
const connectionExists = async (connId: string) =>
  (await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE id = ${connId}`).length > 0
const del = (connId: string, confirm?: boolean) =>
  app.inject({ method: 'DELETE', url: `/admin/connections/${connId}${confirm ? '?confirm=1' : ''}`, headers: tenant.AUTH })

describe('#960: deleting a connection takes its links with it, atomically', () => {
  it('a member with another credential is untouched by the strand check, and the link goes with the connection', async () => {
    const conn = await makeConnection()
    const sub = `t960-cascade-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'member')`
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'x')`
    await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
                VALUES (${tenant.id}, ${conn.id}, 't960-ext', ${sub})`
    try {
      const res = await del(conn.id)
      expect(res.statusCode, res.body).toBe(204)
      expect(await linkCount(conn.id), 'the link does not outlive the connection it named').toBe(0)
      expect(await connectionExists(conn.id)).toBe(false)
    } finally {
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${conn.id}`.catch(() => {})
    }
  })

  it('an unconfirmed delete that would strand a member is refused, and touches neither row', async () => {
    const conn = await makeConnection()
    const sub = `t960-strand-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'member')`
    // No credential, no other connection: this link is the member's only way in.
    await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
                VALUES (${tenant.id}, ${conn.id}, 't960-ext-strand', ${sub})`
    try {
      const refused = await del(conn.id)
      expect(refused.statusCode, refused.body).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'confirm_required', strandedSubs: [sub] })
      expect(await linkCount(conn.id), 'refused — nothing touched').toBe(1)
      expect(await connectionExists(conn.id)).toBe(true)

      const confirmed = await del(conn.id, true)
      expect(confirmed.statusCode, confirmed.body).toBe(204)
      expect(await linkCount(conn.id)).toBe(0)
      expect(await connectionExists(conn.id)).toBe(false)
    } finally {
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${conn.id}`.catch(() => {})
    }
  })

  it('a member reachable only by the MINT-DERIVED entrance (no link at all) is named the same way', async () => {
    const conn = await makeConnection()
    const sub = `${conn.prefix}mint-only`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'member')`
    try {
      const refused = await del(conn.id)
      expect(refused.statusCode, refused.body).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'confirm_required', strandedSubs: [sub] })

      const confirmed = await del(conn.id, true)
      expect(confirmed.statusCode, confirmed.body).toBe(204)
    } finally {
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${conn.id}`.catch(() => {})
    }
  })

  it('the delete is atomic — a failure after both statements leaves both rows standing', async () => {
    const conn = await makeConnection()
    const sub = `t960-atomic-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'member')`
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                VALUES (${tenant.id}, ${sub}, ${`${sub}@t960.test`}, 'x')`
    await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
                VALUES (${tenant.id}, ${conn.id}, 't960-ext-atomic', ${sub})`
    const fnName = `t960_boom_${STAMP}`
    const trgName = `t960_trg_${STAMP}`
    await admin.unsafe(`
      CREATE FUNCTION ${fnName}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 't960: injected failure after both deletes'; END;
      $$ LANGUAGE plpgsql`)
    await admin.unsafe(`
      CREATE CONSTRAINT TRIGGER ${trgName} AFTER DELETE ON tenant_oidc
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fnName}()`)
    try {
      const res = await del(conn.id)
      // The route's handler throws when the transaction's COMMIT rejects; unhandled in this fixture, it
      // surfaces as a 500 — the exact status does not matter, only that it did NOT return 204.
      expect(res.statusCode, res.body).not.toBe(204)
      expect(await linkCount(conn.id), 'the injected failure rolled the WHOLE transaction back').toBe(1)
      expect(await connectionExists(conn.id), 'the connection row survives the rollback too').toBe(true)
    } finally {
      await admin.unsafe(`DROP TRIGGER IF EXISTS ${trgName} ON tenant_oidc`).catch(() => {})
      await admin.unsafe(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {})
      await admin`DELETE FROM member_identities WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${conn.id}`.catch(() => {})
    }
  })
})
