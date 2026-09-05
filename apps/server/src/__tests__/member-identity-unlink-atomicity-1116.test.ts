// #1116 (#1064's independent review, side note, reconfirmed at the 2026-09-05 review):
// the unlink route's own comment (auth.ts, right above `req.db.tx`) documents that the link-row
// delete, the audit write, and the connection's group-slice revoke share ONE transaction — but no pin
// ever made the slice revoke actually FAIL and checked that the whole thing rolls back. The 14
// existing #1045/#1064 tests only exercise the happy path.
//
// This pin makes `revokeMemberConnectionSlice`'s own FGA call throw (by breaking `app.fga.write`,
// the same monkey-patch shape `auth-local-login-568.test.ts` uses on `fgaClient.check`) and checks
// that NOTHING it should have touched moved: the link row, the group-slice row, the member's `groups`
// mirror, the FGA tuple, and the audit row all stay exactly as they were before the call.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { generateTotpSecret, totpCode } from '../auth/totp.js'
import { startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import { recordConnectionGroups, unionForMember, syncMemberGroups, groupFgaId } from '../auth/group-sync.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `t1116-${STAMP}`
let pt: PrivateTenant
let TENANT: string
let HOST: string
let app: FastifyInstance
let db: TenantDb
const SUB = `p1116-${STAMP}`
const CONN = `connA-1116-${STAMP}`
const GROUP = `g1116-${STAMP}`

beforeAll(async () => {
  pt = await privateTenant(adminPool, SLUG)
  TENANT = pt.id
  HOST = `${pt.slug}.localhost`
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb({ id: TENANT, slug: pt.slug, plan: 'business', isolation: 'logical' } as unknown as Tenant)

  await adminPool`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${SUB}, ${`${SUB}@e2e.test`}, 'member')`
  await writeTuples(fgaClient, [{ user: `user:${SUB}`, relation: 'member', object: `tenant:${TENANT}` }])
  await adminPool`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
    VALUES (${TENANT}, ${CONN}, ${'ext-1116'}, ${SUB})`
  // A second link, so the unlink under test is not refused as the member's last way in.
  await adminPool`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
    VALUES (${TENANT}, ${`connB-1116-${STAMP}`}, ${'ext-1116-b'}, ${SUB})`
  // Seed a live group slice on CONN, the same way a real login through it would (member-identity-unlink-1045.test.ts's own helper shape).
  await recordConnectionGroups(db.sql, TENANT, CONN, SUB, [GROUP])
  const next = await unionForMember(db.sql, TENANT, SUB)
  await db.sql`UPDATE members SET groups = ${db.sql.array(next)} WHERE tenant_id = ${TENANT} AND sub = ${SUB}`
  await syncMemberGroups(fgaClient, TENANT, SUB, [], next)
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${SUB}`, relation: 'member', object: `tenant:${TENANT}` },
    { user: `user:${SUB}`, relation: 'member', object: `group:${groupFgaId(TENANT, GROUP)}` },
  ]).catch(() => {})
  await db.release(); await app.close(); await pt.dispose(); await adminPool.end(); await pool.end()
}, 60_000)

const sliceExists = async () => {
  const [row] = await adminPool`SELECT 1 FROM member_connection_groups WHERE tenant_id = ${TENANT} AND connection_id = ${CONN} AND member_sub = ${SUB}`
  return !!row
}
const linkExists = async () => {
  const [row] = await adminPool`SELECT 1 FROM member_identities WHERE tenant_id = ${TENANT} AND connection_id = ${CONN} AND member_sub = ${SUB}`
  return !!row
}
const groupsOf = async (): Promise<string[]> => {
  const [row] = await adminPool<{ groups: string[] }[]>`SELECT groups FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB}`
  return [...(row?.groups ?? [])].sort()
}
const inFgaGroup = async () =>
  (await fgaClient.check({ user: `user:${SUB}`, relation: 'member', object: `group:${groupFgaId(TENANT, GROUP)}` })).allowed === true
const auditCount = async () =>
  adminPool<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log
    WHERE tenant_id = ${TENANT} AND action = 'member.identity_unlinked' AND target = ${`member:${SUB}`}`.then((r) => r[0]!.n)

describe('#1116: unlink is atomic — a failed slice revoke rolls back the link delete and the audit write too', () => {
  it('⚠️ break-check target: app.fga.write throwing mid-tx leaves EVERYTHING as it was', async () => {
    // Pre-conditions, so a false pass (row already missing for some other reason) cannot slip through.
    expect(await linkExists(), 'setup: the link exists before the call').toBe(true)
    expect(await sliceExists(), 'setup: the slice exists before the call').toBe(true)
    expect(await groupsOf(), 'setup: the mirror carries the group before the call').toEqual([GROUP])
    expect(await inFgaGroup(), 'setup: FGA carries the tuple before the call').toBe(true)
    const auditBefore = await auditCount()

    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: SUB, secret })
    await confirmFactor(db, factorId)
    const sid = await createSession(app.valkey, { tenantId: TENANT, sub: SUB, door: 'local+factor' })

    const realWrite = app.fga.write.bind(app.fga)
    ;(app.fga as unknown as { write: unknown }).write = async () => { throw new Error('FGA unreachable (#1116 break-check)') }
    let res
    try {
      res = await app.inject({
        method: 'DELETE', url: `/me/connections/${CONN}/link`,
        headers: { host: HOST, cookie: `${SESSION_COOKIE}=${sid}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
      })
    } finally {
      ;(app.fga as unknown as { write: unknown }).write = realWrite
    }

    expect(res.statusCode, 'a broken slice revoke surfaces as a 500, not a silent partial success').toBe(500)
    expect(await linkExists(), 'the tx rolled back — the link row must still be there').toBe(true)
    expect(await sliceExists(), 'the tx rolled back — the slice row must still be there').toBe(true)
    expect(await groupsOf(), 'the tx rolled back — the mirror must be untouched').toEqual([GROUP])
    expect(await inFgaGroup(), 'FGA membership must be untouched (the real write never went through)').toBe(true)
    expect(await auditCount(), 'the audit write shares the tx too — no row must have landed').toBe(auditBefore)
  }, 60_000)
})
