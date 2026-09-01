// #995 / ADR-269 §2.1 §2.3 §5: an invite is "accepted" if and only if a member was actually seated.
//
// The defect: both acceptance functions ran `UPDATE invites SET status='accepted'` first and then, when
// the seat fortress refused (`address_taken`) or a pre-check failed, RETURNED false from inside the
// `tx` callback. postgres.js commits a callback that resolves, so the refusal was recorded as an
// acceptance: an invite nobody could use any more, a member who was never seated, and an administrator
// who could neither resend nor revoke it (both act on `status='pending'`). Every assertion below reads
// the ROW, not the boolean — the boolean was right the whole time.
//
// Real Postgres + OpenFGA, through the shipped functions and the shipped HTTP door.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createInvite, acceptLocalInvite, acceptInvite, reissueInvite, revokeInvite } from '../auth/invites.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const PASSWORD = 'rollback-995-passphrase-1'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
const emails: string[] = []
const subs: string[] = []
const tenant = { id: TENANT, plan: 'business' }

const email = (n: string) => { const e = `rb995-${n}-${STAMP}@e2e.test`; emails.push(e); return e }
const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
const localInvite = (addr: string) =>
  createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member', kind: 'local' })
const oidcInvite = (addr: string) =>
  createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member' })
const statusOf = async (id: string): Promise<string> =>
  (await adminPool<{ status: string }[]>`SELECT status FROM invites WHERE id = ${id}`)[0]!.status
const membersWith = async (addr: string): Promise<number> =>
  Number((await adminPool<{ n: string }[]>`
    SELECT count(*) AS n FROM members WHERE tenant_id = ${TENANT} AND lower(email) = ${addr.toLowerCase()}`)[0]!.n)

/** Somebody already here at that address, by a door that asked no invite (SCIM, a first OIDC sign-in). */
let seated = 0
const seatMember = async (addr: string): Promise<void> => {
  const sub = `rb995-existing-${STAMP}-${++seated}`
  subs.push(sub)
  await adminPool`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${addr}, 'member')
                  ON CONFLICT (tenant_id, sub) DO NOTHING`
}

/** The one signal the ruling requires in every deployment: a structured log line, captured here. */
const captured: { level: string; obj: unknown; msg: string }[] = []
const log = {
  warn: (obj: unknown, msg: string) => { captured.push({ level: 'warn', obj, msg }) },
  info: (obj: unknown, msg: string) => { captured.push({ level: 'info', obj, msg }) },
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  for (const e of emails) {
    const creds = await adminPool<{ member_sub: string }[]>`SELECT member_sub FROM local_credentials WHERE identifier = ${e}`
    for (const { member_sub } of creds) {
      await adminPool`DELETE FROM local_credentials WHERE member_sub = ${member_sub}`.catch(() => {})
      await adminPool`DELETE FROM members WHERE sub = ${member_sub}`.catch(() => {})
    }
    await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${e}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND lower(email) = ${e.toLowerCase()}`.catch(() => {})
  }
  for (const s of subs) await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${s}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#995 / ADR-269 §2.1: a refused acceptance leaves the invite pending', () => {
  it('local door, address held: the row stays pending, the admin can resend AND revoke it, one signal is logged', async () => {
    const addr = email('local-held')
    const { id, token } = await localInvite(addr)
    await seatMember(addr)
    captured.length = 0

    const result = await acceptLocalInvite({ db, fga: fgaClient, log }, tenant, token, PASSWORD)
    expect(result.ok, 'the uniform refusal, unchanged').toBe(false)
    expect(await statusOf(id), 'the row was NOT burned by a refusal (the break-check: `return` inside the tx reads accepted here)').toBe('pending')
    expect(await membersWith(addr), 'and nobody was seated twice').toBe(1)

    // §2.1's stated consequence: the administrator's own recovery actions work again.
    const reissued = await reissueInvite(db, id)
    expect(reissued, 'resend finds a pending invite').not.toBeNull()
    expect(await revokeInvite(db, id), 'and so does revoke').toBe(true)

    // The ruling's signal, present without any entitlement or mail driver.
    const blocked = captured.filter((c) => /invite/i.test(c.msg) && /blocked|refused/i.test(c.msg))
    expect(blocked.length, 'exactly one structured line per blocked accept').toBe(1)
    const obj = blocked[0]!.obj as Record<string, unknown>
    expect(obj.inviteId, 'it names the invite, which the admin already sees').toBe(id)
    expect(obj.reason).toBe('address_taken')
    expect(JSON.stringify(obj), 'and never the address or the claimant').not.toContain(addr)
  }, 120_000)

  it('OIDC door, address held: the same — pending, re-triable, one signal', async () => {
    const addr = email('oidc-held')
    const { id, token } = await oidcInvite(addr)
    await seatMember(addr)
    captured.length = 0
    const sub = `rb995-oidc-${STAMP}`
    subs.push(sub)

    const ok = await acceptInvite({ db, fga: fgaClient, log }, tenant, token, { sub, email: addr })
    expect(ok).toBe(false)
    expect(await statusOf(id)).toBe('pending')
    expect((await adminPool`SELECT 1 FROM members WHERE tenant_id = ${TENANT} AND sub = ${sub}`).length).toBe(0)
    expect(await reissueInvite(db, id)).not.toBeNull()
    expect(captured.filter((c) => /invite/i.test(c.msg)).length).toBe(1)
  }, 120_000)

  it('local door, pre-check refusal (credential identifier already taken): the same rollback', async () => {
    // The identifier collision is answered BEFORE the fortress, on the local door's own pre-check; it
    // shares the commit-on-return defect (§1.3) and gets the same treatment.
    const addr = email('local-cred')
    // Two links for one address, BOTH issued while it was free (#606 refuses to issue one for a held
    // address, so the second cannot be minted after the first accept). Accepting the first seats them;
    // the second then meets the identifier pre-check.
    const first = await localInvite(addr)
    const second = await localInvite(addr)
    expect((await acceptLocalInvite({ db, fga: fgaClient, log }, tenant, first.token, PASSWORD)).ok, 'the first accept seats them').toBe(true)
    const result = await acceptLocalInvite({ db, fga: fgaClient, log }, tenant, second.token, PASSWORD)
    expect(result.ok).toBe(false)
    expect(await statusOf(second.id), 'the second invite is still pending, not falsely burned').toBe('pending')
  }, 120_000)

  it('the invitee sees byte-for-byte the same HTTP answer as before (§5)', async () => {
    const addr = email('http')
    const { token } = await localInvite(addr)
    await seatMember(addr)
    const blocked = await app.inject({ method: 'POST', url: '/auth/local/accept', headers: H, payload: { token, password: PASSWORD } })
    const dead = await app.inject({ method: 'POST', url: '/auth/local/accept', headers: H, payload: { token: 'inv_dead', password: PASSWORD } })
    expect(blocked.statusCode, 'a blocked accept').toBe(dead.statusCode)
    expect(blocked.body, 'is the dead-link answer, verbatim').toBe(dead.body)
    expect(blocked.statusCode).toBe(404)
  }, 120_000)

  it('positive control: an uncontested accept still flips the row to accepted and logs nothing', async () => {
    const addr = email('fresh')
    const { id, token } = await localInvite(addr)
    captured.length = 0
    expect((await acceptLocalInvite({ db, fga: fgaClient, log }, tenant, token, PASSWORD)).ok).toBe(true)
    expect(await statusOf(id)).toBe('accepted')
    expect(await membersWith(addr)).toBe(1)
    expect(captured.filter((c) => /invite/i.test(c.msg)).length, 'no blocked-accept signal on the happy path').toBe(0)
  }, 120_000)
})
