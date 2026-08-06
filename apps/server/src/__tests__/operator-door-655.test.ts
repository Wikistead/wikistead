// #655 review reject: `operator` existed in the type and nothing could write it.
//
// The break-glass invite is the one #616 exempted from the SSO stance — the way back in when every
// other entrance is shut. ADR-219 §4 gives it the same standing against the second-factor requirement,
// so the session it opens has to say `operator`. Recording it as `local` would send the operator to an
// interstitial: the thing that exists to get around a lockout, shut by a lockout.
//
// Driven through the real route and read out of the real session, because the earlier pin wrote
// sessions into Valkey directly and so never showed that a LOGIN puts the door there.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { createInvite } from '../auth/invites.js'
import { buildApp } from '../app.js'
import { readSession, doorOf, SESSION_COOKIE } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const PASSWORD = 'operator-door-passphrase-1'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let valkey: IORedis
let restoreLocalLogin: string | null = null

const email = (n: string) => `opdoor655-${n}-${STAMP}@e2e.test`

async function invite(n: string, operatorIssued: boolean): Promise<string> {
  const { token } = await createInvite(db, {
    tenantId: T, plan: 'business', invitedBy: 'dev-user', email: email(n), role: 'member', kind: 'local',
    ...(operatorIssued ? { operatorOverride: true } : {}),
  })
  return token
}

/** Accept through the route and read the door out of the session the cookie names. */
async function doorAfterAccepting(token: string): Promise<string | null> {
  const res = await app.inject({ method: 'POST', url: '/auth/local/accept', headers: H, payload: { token, password: PASSWORD } })
  if (res.statusCode !== 201) return `HTTP ${res.statusCode}: ${res.body}`
  const sid = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value
  if (!sid) return null
  const s = await readSession(valkey, sid)
  return s ? doorOf(s) : null
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  valkey = app.valkey
  // The password door has to be open for an acceptance to complete. Restored in afterAll: leaving it on
  // turns `#537 tenant-oidc lockout guard` red in a full run, because that guard reasons about which
  // sign-in methods remain (handed over by session A, measured).
  const [row] = await admin<{ v: string | null }[]>`SELECT local_login_enabled::text AS v FROM tenant_login_prefs WHERE tenant_id = ${T}`
  restoreLocalLogin = row?.v ?? null
  await admin`
    INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${T}, true)
    ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true`
}, 180_000)

afterAll(async () => {
  if (restoreLocalLogin !== null) {
    await admin`UPDATE tenant_login_prefs SET local_login_enabled = ${restoreLocalLogin === 'true'} WHERE tenant_id = ${T}`.catch(() => {})
  }
  // Accepting SEATS someone, and the seat outlives the invite row. Read the subs BEFORE deleting the
  // invites that name them — the first version deleted the invites first and left two members in
  // tenant_dev, which pushed the tenant over the cap that `plan-freeze` and `invite-role-582` measure.
  // Same shape as #638's leak, found the same way: green alone, red in a full run.
  const seated = (await admin<{ accepted_sub: string | null }[]>`
    SELECT accepted_sub FROM invites WHERE tenant_id = ${T} AND email LIKE ${`opdoor655-%-${STAMP}@e2e.test`}`)
    .map((r) => r.accepted_sub).filter((s): s is string => !!s)
  await admin`DELETE FROM local_credentials WHERE identifier LIKE ${`opdoor655-%-${STAMP}@e2e.test`}`.catch(() => {})
  await admin`DELETE FROM invites WHERE tenant_id = ${T} AND email LIKE ${`opdoor655-%-${STAMP}@e2e.test`}`.catch(() => {})
  if (seated.length) {
    await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = ANY(${seated})`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ANY(${seated})`.catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#655: the break-glass acceptance opens an operator session', () => {
  it('an operator-issued invite records `operator`', async () => {
    expect(await doorAfterAccepting(await invite('op', true))).toBe('operator')
  }, 180_000)

  it('…and an ordinary invite through the same route records `local`', async () => {
    // The control. Without it, an implementation that wrote `operator` for every acceptance would pass
    // the case above — and would hand the exemption to everybody who ever accepted an invitation.
    expect(await doorAfterAccepting(await invite('plain', false))).toBe('local')
  }, 180_000)
})
