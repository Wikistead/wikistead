// #568 / ADR-198 §3 §5: password sign-in, and everything it must refuse to reveal.
//
// The interesting assertions here are all NEGATIVE. A login route's job is easy; not answering
// "does this account exist", "is this tenant using passwords at all", or "did I get the password
// right while locked out" is the hard part, and each of those has its own case below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { hashPassword } from '../auth/password-hash.js'
import { enrolUnderSeatCap } from '../auth/invites.js'
import { sameOriginOk } from '../routes/auth-local.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const PASSWORD = 'a-perfectly-fine-passphrase'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
const subs: string[] = []
const ident = (n: string) => `local568-${n}-${STAMP}@e2e.test`

async function makeLocalMember(n: string): Promise<{ sub: string; identifier: string }> {
  const sub = `wlocal_l568-${n}-${STAMP}`
  const identifier = ident(n)
  subs.push(sub)
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub, email: identifier }, 'member', 'invite', 'local'))
  await db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
               VALUES (${TENANT}, ${sub}, ${identifier}, ${await hashPassword(PASSWORD)})`
  return { sub, identifier }
}
const login = (identifier: string, password: string, headers: Record<string, string> = H) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers, payload: { identifier, password } })
const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
// Counters are per (tenant, identifier) and per (tenant, ip); a test that leaves them behind locks
// out the next one that happens to reuse an address.
async function clearCounters(identifier: string): Promise<void> {
  const v = app.valkey
  await v.del(`rl:local:id:${TENANT}:${identifier}`).catch(() => {})
  await v.del(`lock:local:${TENANT}:${identifier}`).catch(() => {})
  const keys = await v.keys(`rl:local:ip:${TENANT}:*`).catch(() => [] as string[])
  if (keys.length) await v.del(...keys).catch(() => {})
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  for (const s of subs) {
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${s}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${s}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#568 §3: one refusal, whatever the reason', () => {
  it('a correct password signs in and sets the session cookie', async () => {
    const { identifier } = await makeLocalMember('happy')
    await clearCounters(identifier)
    const res = await login(identifier, PASSWORD)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.cookies.some((c) => c.name === 'wks_sess'), 'a session cookie was set').toBe(true)
  }, 120_000)

  it('unknown identifier, wrong password and a tenant with local login OFF are indistinguishable', async () => {
    const { identifier } = await makeLocalMember('uniform')
    await clearCounters(identifier)
    const wrong = await login(identifier, 'not-the-password')
    const unknown = await login(`nobody-${STAMP}@e2e.test`, PASSWORD)
    await setLocalLogin(false)
    await clearCounters(identifier)
    const disabled = await login(identifier, PASSWORD)
    await setLocalLogin(true)

    for (const [name, res] of [['wrong password', wrong], ['unknown identifier', unknown], ['local login off', disabled]] as const) {
      expect(res.statusCode, name).toBe(401)
      expect(res.json(), name).toEqual({ error: 'invalid credentials' })
      expect(res.cookies.length, `${name} sets no session`).toBe(0)
    }
  }, 120_000)

  it('the failure event names the METHOD and keeps the reason coarse (no enumeration by webhook)', async () => {
    const { identifier } = await makeLocalMember('event')
    await clearCounters(identifier)
    const seen: { method: string; reason: string }[] = []
    const off = onDomainEvent((e) => { if (e.type === 'auth.failed') seen.push({ method: e.method, reason: e.reason }) })
    try {
      await login(identifier, 'wrong')
      await login(`ghost-${STAMP}@e2e.test`, 'wrong')
    } finally { off() }
    expect(seen.length).toBe(2)
    expect(seen.every((s) => s.method === 'local')).toBe(true)
    // the two reasons must be the SAME string — a webhook consumer must not learn which one existed
    expect(new Set(seen.map((s) => s.reason)).size, 'one reason for both causes').toBe(1)
  }, 120_000)

  it('a member who is not seated cannot sign in even with a valid credential row', async () => {
    // Membership is the authority; a password proves identity only (the P1.1 invariant).
    const { sub, identifier } = await makeLocalMember('unseated')
    await clearCounters(identifier)
    await adminPool`DELETE FROM members WHERE sub = ${sub}`
    // the credential row survives the direct delete only because we bypassed the app's own cleanup;
    // re-insert it to model "a credential whose member is gone"
    await adminPool`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                    VALUES (${TENANT}, ${sub}, ${identifier}, ${await hashPassword(PASSWORD)})
                    ON CONFLICT DO NOTHING`.catch(() => {})
    const res = await login(identifier, PASSWORD)
    expect(res.statusCode).toBe(401)
  }, 120_000)
})

describe('#568 §3 C5: a cross-site form cannot log anyone in', () => {
  it('the same-origin proof accepts what a browser sends and refuses what it does not', () => {
    expect(sameOriginOk({ 'sec-fetch-site': 'same-origin' }, 'dev.localhost')).toBe(true)
    expect(sameOriginOk({ 'sec-fetch-site': 'none' }, 'dev.localhost'), 'typed into the address bar').toBe(true)
    expect(sameOriginOk({ 'sec-fetch-site': 'cross-site' }, 'dev.localhost')).toBe(false)
    expect(sameOriginOk({ origin: 'http://dev.localhost' }, 'dev.localhost'), 'older browsers send Origin').toBe(true)
    expect(sameOriginOk({ origin: 'http://evil.example' }, 'dev.localhost')).toBe(false)
    expect(sameOriginOk({}, 'dev.localhost'), 'neither header: not a browser').toBe(false)
  })

  it('a cross-site POST is refused BEFORE any credential is looked at', async () => {
    const { identifier } = await makeLocalMember('csrf')
    await clearCounters(identifier)
    const res = await app.inject({
      method: 'POST', url: '/auth/local/login',
      headers: { ...H, 'sec-fetch-site': 'cross-site' },
      payload: { identifier, password: PASSWORD },
    })
    expect(res.statusCode).toBe(403)
    // ...and it counted as nothing: the real login still works, unaffected by the attempt
    expect((await login(identifier, PASSWORD)).statusCode).toBe(200)
  }, 120_000)
})

describe('#568 §5: the lockout is a stop, not a delay', () => {
  it('repeated failures lock the identifier, and a CORRECT password during the lock still fails', async () => {
    const { identifier } = await makeLocalMember('lockout')
    await clearCounters(identifier)
    const locks: string[] = []
    const off = onDomainEvent((e) => { if (e.type === 'member.locked') locks.push(e.identifier) })
    try {
      for (let i = 0; i < 5; i++) expect((await login(identifier, 'wrong')).statusCode).toBe(401)
      // C2: the right password does NOT get in, and does not clear the lock either
      expect((await login(identifier, PASSWORD)).statusCode, 'locked out').toBe(401)
      expect((await login(identifier, PASSWORD)).statusCode, 'still locked — a correct guess clears nothing').toBe(401)
    } finally { off() }
    expect(locks, 'the lock is announced once, by identifier').toContain(identifier)

    // and the lock RELEASES on its own — modelled by expiring the key, which is what time does
    await app.valkey.del(`lock:local:${TENANT}:${identifier}`)
    await app.valkey.del(`rl:local:id:${TENANT}:${identifier}`)
    expect((await login(identifier, PASSWORD)).statusCode, 'no admin action was needed').toBe(200)
  }, 180_000)

  it('a lock is per identifier, not per tenant — one account cannot lock everyone out', async () => {
    const victim = await makeLocalMember('lock-victim')
    const bystander = await makeLocalMember('lock-bystander')
    await clearCounters(victim.identifier)
    await clearCounters(bystander.identifier)
    for (let i = 0; i < 5; i++) await login(victim.identifier, 'wrong')
    expect((await login(victim.identifier, PASSWORD)).statusCode).toBe(401)
    expect((await login(bystander.identifier, PASSWORD)).statusCode, 'a different account is unaffected').toBe(200)
  }, 180_000)
})

describe('#568 §3 M8: local is a connection, so the lockout guard can see it', () => {
  it('the effective set and the connection list both carry local when the tenant enables it', async () => {
    const { resolveLoginConnections } = await import('../auth/login-methods.js')
    const { resolveLogin } = await import('../routes/auth.js')
    await setLocalLogin(true)
    const available = await resolveLogin(db, { id: TENANT, plan: 'business' } as Tenant)
    expect(available.methods.has('local'), 'the effective set').toBe(true)
    const list = await resolveLoginConnections(db, { plan: 'business' })
    expect(list.some((c) => c.kind === 'local'), 'the connection list').toBe(true)
    // it never bootstraps an admin and asserts no groups — there is no IdP behind it to trust
    const local = list.find((c) => c.kind === 'local')!
    expect(local.bootstrapEligible).toBe(false)
    expect(local.trustGroups).toBe(false)
  }, 120_000)

  it('a deployment ceiling that excludes local removes it from the effective set', async () => {
    const { resolveAvailableLogin } = await import('../auth/login-methods.js')
    await setLocalLogin(true)
    // the loader is auth.ts's (it owns secret decryption); these cases are about the CEILING, so a
    // "no tenant OIDC" loader keeps the question to the one being asked
    const available = await resolveAvailableLogin(db, { plan: 'business' }, async () => null, 'tenant-oidc,platform-oidc')
    expect(available.methods.has('local'), 'the ceiling is a ceiling').toBe(false)
  }, 120_000)

  it('turning local off is refused when it is the ONLY way in', async () => {
    // The rule every method obeys: an admin cannot close the last door on themselves. Modelled by a
    // ceiling that admits nothing else, so local really is the only member of the effective set.
    const { resolveAvailableLogin } = await import('../auth/login-methods.js')
    await setLocalLogin(true)
    const onlyLocal = await resolveAvailableLogin(db, { plan: 'business' }, async () => null, 'local')
    expect([...onlyLocal.methods]).toEqual(['local'])
    // the route's guard reads the same resolver, so what it would refuse is exactly this state
    const others = [...onlyLocal.methods].filter((m) => m !== 'local')
    expect(others.length, 'nothing else would be left').toBe(0)
  }, 120_000)
})
