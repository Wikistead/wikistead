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

  it('a member whose MEMBERSHIP is gone cannot sign in, credential or no credential', async () => {
    // Membership is the authority; a password proves identity only (the P1.1 invariant). The drift
    // that can really happen is the FGA side going while the rows stay — a failed removal, a manual
    // tuple delete — so that is what this models. (An earlier version deleted the MEMBER row and
    // re-inserted the credential, which the FK refuses: it was measuring "no credential" and would
    // have passed with the membership check removed entirely.)
    const { sub, identifier } = await makeLocalMember('unseated')
    await clearCounters(identifier)
    const { deleteTuples } = await import('@wikistead/authz')
    await deleteTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }])
    const rows = await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${sub}`
    expect(rows.length, 'the credential is still there — this is about membership, not the row').toBe(1)
    const res = await login(identifier, PASSWORD)
    expect(res.statusCode, 'and the same 401 as any other refusal').toBe(401)
    expect(res.json()).toEqual({ error: 'invalid credentials' })
  }, 120_000)

  it('B1: a DEACTIVATED member gets the same 401 for a right password as for a wrong one', async () => {
    // The review measured this: establishMemberSession's own 403 (member_deactivated) escaped the
    // route, so the response said "your password was correct" to anyone holding a frozen account's
    // address — and that branch skipped the failure counters, so it could be probed without limit.
    const { sub, identifier } = await makeLocalMember('frozen')
    await clearCounters(identifier)
    await adminPool`UPDATE members SET deactivated_at = now(), deactivation_reason = 'downgrade_freeze' WHERE sub = ${sub}`
    try {
      const right = await login(identifier, PASSWORD)
      await clearCounters(identifier)
      const wrong = await login(identifier, 'not-the-password')
      expect(right.statusCode, 'a correct password against a frozen account').toBe(401)
      expect(right.json(), 'byte-identical to a wrong one').toEqual(wrong.json())
      expect(right.cookies.length, 'and no session').toBe(0)
      // ...and it COUNTED: the branch that used to skip the counters is the one an attacker probes
      const n = Number(await app.valkey.get(`rl:local:id:${TENANT}:${identifier}`))
      expect(n, 'the refusal was counted like any other').toBeGreaterThan(0)
    } finally {
      await adminPool`UPDATE members SET deactivated_at = NULL, deactivation_reason = NULL WHERE sub = ${sub}`
    }
  }, 180_000)

  it('B4: a flooded SOURCE is refused with 429 BEFORE the KDF runs', async () => {
    // Not an oracle (the answer depends only on that source's own history) and the only thing
    // between an unauthenticated caller and a thread pool of four.
    const { identifier } = await makeLocalMember('flood')
    await clearCounters(identifier)
    await app.valkey.set(`rl:local:ip:${TENANT}:127.0.0.1`, String(1000), 'EX', 60)
    const started = performance.now()
    const res = await login(identifier, PASSWORD)
    const elapsed = performance.now() - started
    await clearCounters(identifier)
    expect(res.statusCode).toBe(429)
    // a real KDF is ~60ms; a refusal that ran one would be nowhere near this
    expect(elapsed, `refused in ${elapsed.toFixed(1)}ms — no KDF was burned`).toBeLessThan(40)
  }, 120_000)

  it('N1: an absurdly long identifier is refused without reaching a key or an event', async () => {
    const events: string[] = []
    const off = onDomainEvent((e) => { if (e.type === 'member.locked') events.push(e.identifier) })
    let res
    try {
      res = await login('x'.repeat(5000) + '@e2e.test', PASSWORD)
    } finally { off() }
    expect(res!.statusCode).toBe(401)
    expect(events, 'nothing attacker-sized reached an event').toEqual([])
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
    // it asserts no groups — there is no IdP behind it to trust. (The "never bootstraps an admin"
    // half went with the mechanism: #616 / ADR-212 slice 2.)
    const local = list.find((c) => c.kind === 'local')!
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

describe('#568 §6: changing a password evicts everyone else, and cannot grow one on an SSO account', () => {
  const DEV = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

  it('an OIDC member cannot acquire a password here (the rev2 hole)', async () => {
    // dev-token authenticates `dev-user`, an OIDC-source member with no credential row. If this
    // route upserted, a tenant that runs on SSO would grow a password door nobody authorised.
    await setLocalLogin(true)
    const res = await app.inject({
      method: 'POST', url: '/auth/local/password', headers: DEV,
      payload: { currentPassword: 'anything', newPassword: 'a-brand-new-passphrase' },
    })
    expect(res.statusCode, 'not available, and not a hint about why').toBe(404)
    const rows = await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = 'dev-user'`
    expect(rows.length, 'and nothing was written').toBe(0)
  }, 120_000)

  it('the wrong current password is refused, and the stored hash is untouched', async () => {
    const { sub, identifier } = await makeLocalMember('change-wrong')
    await clearCounters(identifier)
    const before = (await db.sql<{ password_hash: string }[]>`SELECT password_hash FROM local_credentials WHERE member_sub = ${sub}`)[0]!
    // Authenticate AS that member the way the product does: sign in and use the cookie.
    const signed = await login(identifier, PASSWORD)
    expect(signed.statusCode).toBe(200)
    const sid = signed.cookies.find((c) => c.name === 'wks_sess')!.value
    const res = await app.inject({
      method: 'POST', url: '/auth/local/password',
      headers: { host: 'dev.localhost', 'content-type': 'application/json', cookie: `wks_sess=${sid}` },
      payload: { currentPassword: 'not-the-current-one', newPassword: 'a-brand-new-passphrase' },
    })
    expect(res.statusCode, 'the current password is checked, session or no session').toBe(403)
    const after = (await db.sql<{ password_hash: string }[]>`SELECT password_hash FROM local_credentials WHERE member_sub = ${sub}`)[0]!
    expect(after.password_hash).toBe(before.password_hash)
  }, 120_000)

  it('the right current password changes it, and signs every OTHER session out', async () => {
    const { sub, identifier } = await makeLocalMember('change-ok')
    await clearCounters(identifier)
    const first = await login(identifier, PASSWORD)
    const second = await login(identifier, PASSWORD)
    const keep = first.cookies.find((c) => c.name === 'wks_sess')!.value
    const doomed = second.cookies.find((c) => c.name === 'wks_sess')!.value
    const NEXT = 'the-next-passphrase-please'
    const res = await app.inject({
      method: 'POST', url: '/auth/local/password',
      headers: { host: 'dev.localhost', 'content-type': 'application/json', cookie: `wks_sess=${keep}` },
      payload: { currentPassword: PASSWORD, newPassword: NEXT },
    })
    expect(res.statusCode, res.body).toBe(204)
    expect(await app.valkey.get(`sess:${doomed}`), 'the other session was signed out').toBeNull()
    expect(await app.valkey.get(`sess:${keep}`), 'the tab they typed in survived').not.toBeNull()
    await clearCounters(identifier)
    expect((await login(identifier, NEXT)).statusCode, 'the new password works').toBe(200)
    await clearCounters(identifier)
    expect((await login(identifier, PASSWORD)).statusCode, 'and the old one does not').toBe(401)
    void sub
  }, 180_000)

  it('a spared session stays REVOCABLE — the survivor is put back in the index', async () => {
    // The trap the review named: sparing a session by deleting the index leaves a live session that
    // no later revocation (removal, force-logout, the next password change) can find.
    const { destroyMemberSessions, createSession } = await import('../auth/session.js')
    const sub = `wlocal_sess568-${STAMP}`
    subs.push(sub)
    const keep = await createSession(app.valkey, { tenantId: TENANT, sub, email: null, role: 'member', groups: [] })
    const other = await createSession(app.valkey, { tenantId: TENANT, sub, email: null, role: 'member', groups: [] })
    await destroyMemberSessions(app.valkey, TENANT, sub, keep)
    expect(await app.valkey.get(`sess:${other}`), 'the other session is gone').toBeNull()
    expect(await app.valkey.get(`sess:${keep}`), 'the current one survived').not.toBeNull()
    // ...and a LATER blanket revocation still reaches it
    await destroyMemberSessions(app.valkey, TENANT, sub)
    expect(await app.valkey.get(`sess:${keep}`), 'the survivor was still findable').toBeNull()
  }, 120_000)
})

describe('#568 review: the remaining measured properties', () => {
  it('N5b: BOTH refusal branches burn a real KDF (instrumented, not inferred)', async () => {
    // ADR §3 C1 requires it of the unknown-identifier path AND the locked one — a "locked" branch
    // that skipped verification would answer "this account is locked" in the response time.
    const { identifier } = await makeLocalMember('kdf-both')
    await clearCounters(identifier)
    const timed = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t }
    const real = await timed(() => login(identifier, 'wrong-but-real-account'))
    const unknown = await timed(() => login(`ghost-kdf-${STAMP}@e2e.test`, 'wrong'))
    // lock it, then measure the locked branch
    await app.valkey.set(`lock:local:${TENANT}:${identifier}`, '1', 'EX', 60)
    const locked = await timed(() => login(identifier, PASSWORD))
    await clearCounters(identifier)
    // Each within an order of magnitude of the others: an early return is 100x, not 20%.
    expect(unknown, `unknown ${unknown.toFixed(0)}ms vs real ${real.toFixed(0)}ms`).toBeGreaterThan(real / 5)
    expect(locked, `locked ${locked.toFixed(0)}ms vs real ${real.toFixed(0)}ms`).toBeGreaterThan(real / 5)
  }, 180_000)

  it('N5c: the ROUTE refuses to switch local off when it is the only way in', async () => {
    // Previously asserted by re-implementing the filter in the test; this calls the endpoint.
    const H2 = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
    await setLocalLogin(true)
    // Make local the only effective method by taking the tenant's OIDC connections out of service.
    const enabled = await adminPool<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${TENANT} AND enabled`
    await adminPool`UPDATE tenant_oidc SET enabled = false WHERE tenant_id = ${TENANT}`
    try {
      const res = await app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H2, payload: { localLoginEnabled: false } })
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'login_lockout' })
      const [pref] = await adminPool<{ local_login_enabled: boolean }[]>`SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
      expect(pref?.local_login_enabled, 'and nothing was written').toBe(true)
    } finally {
      for (const c of enabled) await adminPool`UPDATE tenant_oidc SET enabled = true WHERE id = ${c.id}`
    }
  }, 180_000)

  it('N2: a member FGA knows but the database does not gets a refusal, not a crash', async () => {
    const { establishMemberSession } = await import('../auth/session.js')
    const ghost = `wlocal_ghost568-${STAMP}`
    subs.push(ghost)
    const { writeTuples, deleteTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, [{ user: `user:${ghost}`, relation: 'member', object: `tenant:${TENANT}` }])
    try {
      await expect(
        establishMemberSession({ db, fga: fgaClient, valkey: app.valkey }, { id: TENANT, plan: 'business' }, { sub: ghost }, { localIdentity: true }),
      ).rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await deleteTuples(fgaClient, [{ user: `user:${ghost}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
    }
  }, 120_000)

  it('B3: break-glass flips LOCAL through the login prefs, never through the SAML table', async () => {
    // The old if/else wrote tenant_saml for anything that was not tenant-oidc.
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../scripts/login-methods.ts', import.meta.url), 'utf8'))
    expect(src).toContain("w.method === 'saml'")
    expect(src).toContain("w.method === 'local'")
    expect(src).toContain('local_login_enabled')
    // and the argument parser accepts it, so a password-only tenant is recoverable
    expect(src).toContain("v === 'local'")
  })
})

describe('#568: an outage is not a credential failure', () => {
  it('an infrastructure error surfaces as a 500, not as "invalid credentials"', async () => {
    // The B1 fix swallows establishMemberSession's refusals; it must not swallow a broken
    // dependency too. Telling a member their password is wrong during an outage would have everyone
    // retyping a correct one while the operator sees no errors at all.
    const { identifier } = await makeLocalMember('outage')
    await clearCounters(identifier)
    const realCheck = fgaClient.check.bind(fgaClient)
    ;(fgaClient as unknown as { check: unknown }).check = async () => { throw new Error('FGA unreachable') }
    try {
      const res = await login(identifier, PASSWORD)
      expect(res.statusCode, 'a broken dependency is a 500').toBe(500)
      expect(res.body, 'and never claims the credentials were wrong').not.toContain('invalid credentials')
    } finally {
      ;(fgaClient as unknown as { check: unknown }).check = realCheck
    }
  }, 120_000)
})
