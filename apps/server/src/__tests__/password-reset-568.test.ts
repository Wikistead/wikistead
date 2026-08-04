// #568 / ADR-198 §6: self-service password reset.
//
// The request endpoint is unauthenticated and takes an email address, which makes it the cheapest
// account-enumeration surface in the product if it ever answers differently for "yes there is an
// account" and "no there is not". Every case here checks that it does not.
//
// The completion endpoint has the other danger: rev2 keyed off the member's email and could
// therefore CREATE a credential for an `identity_source='oidc'` member — a password door on a tenant
// that had deliberately standardised on SSO. A reset restores access to a password account; it never
// invents one.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { hashPassword, verifyPassword } from '../auth/password-hash.js'
import { mintPasswordReset, completePasswordReset } from '../auth/password-reset.js'
import { enrolUnderSeatCap } from '../auth/invites.js'
import { createSession } from '../auth/session.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const TEN = { id: TENANT, plan: 'business' }
const PASSWORD = 'the-original-passphrase'
const NEXT = 'the-replacement-passphrase'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`

async function makeLocalMember(n: string): Promise<{ sub: string; identifier: string }> {
  const sub = `wlocal_pr568-${n}-${STAMP}`
  const identifier = `pr568-${n}-${STAMP}@e2e.test`
  subs.push(sub)
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub, email: identifier }, 'member', 'invite', 'local'))
  await db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
               VALUES (${TENANT}, ${sub}, ${identifier}, ${await hashPassword(PASSWORD)})`
  return { sub, identifier }
}
async function makeOidcMember(n: string): Promise<{ sub: string; email: string }> {
  const sub = `oidc-pr568-${n}-${STAMP}`
  const email = `pr568-oidc-${n}-${STAMP}@e2e.test`
  subs.push(sub)
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub, email }, 'member', 'invite'))
  return { sub, email }
}
const storedHash = async (sub: string) =>
  (await db.sql<{ password_hash: string }[]>`SELECT password_hash FROM local_credentials WHERE member_sub = ${sub}`)[0]?.password_hash

// The per-source limits are REAL (a reset mints a link and sends mail), and a suite that makes
// dozens of requests from one address trips them — which is the limiter working, not a bug. Clear
// this file's own counters between cases so each one measures what it is about.
beforeEach(async () => {
  const keys = await app.valkey.keys(`rl:local:reset*${TENANT}*`).catch(() => [] as string[])
  if (keys.length) await app.valkey.del(...keys).catch(() => {})
})

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  for (const s of subs) {
    await adminPool`DELETE FROM password_resets WHERE member_sub = ${s}`.catch(() => {})
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${s}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${s}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#568 §6: asking for a reset tells you nothing', () => {
  it('a local account, an OIDC member and a stranger all mint NOTHING visible to the caller', async () => {
    const local = await makeLocalMember('ask-local')
    const oidc = await makeOidcMember('ask-oidc')
    expect(await mintPasswordReset(db, { plan: 'free' }, local.identifier), 'a password account gets a token').not.toBeNull()
    expect(await mintPasswordReset(db, { plan: 'free' }, oidc.email), 'an OIDC member has no credential to reset').toBeNull()
    expect(await mintPasswordReset(db, { plan: 'free' }, `nobody-${STAMP}@e2e.test`), 'a stranger, likewise').toBeNull()
    // ...and the HTTP surface answers 204 to all three, which is the part that matters
    for (const id of [local.identifier, oidc.email, `nobody-${STAMP}@e2e.test`, '']) {
      const res = await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: H, payload: { identifier: id } })
      expect(res.statusCode, `identifier=${id || '(empty)'}`).toBe(204)
      expect(res.body, 'and says nothing at all').toBe('')
    }
  }, 180_000)

  it('an OIDC member cannot acquire a credential through a reset (the rev2 hole)', async () => {
    const oidc = await makeOidcMember('grow')
    await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: H, payload: { identifier: oidc.email } })
    const rows = await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${oidc.sub}`
    expect(rows.length, 'no password was grown on an SSO account').toBe(0)
    const resets = await db.sql`SELECT 1 FROM password_resets WHERE member_sub = ${oidc.sub}`
    expect(resets.length, 'and no reset was minted for one').toBe(0)
  }, 120_000)

  it('with password sign-in switched off, nothing is minted at all', async () => {
    const local = await makeLocalMember('ask-while-off')
    await setLocalLogin(false)
    expect(await mintPasswordReset(db, { plan: 'free' }, local.identifier)).toBeNull()
    await setLocalLogin(true)
  }, 120_000)
})

describe('#568 §6: completing a reset', () => {
  it('replaces the password, kills every session, and cannot be replayed', async () => {
    const { sub, identifier } = await makeLocalMember('complete')
    const before = await storedHash(sub)
    const live = await createSession(app.valkey, { tenantId: TENANT, sub, email: identifier, role: 'member', groups: [] })
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!

    const events: string[] = []
    const off = onDomainEvent((e) => { if (e.type.startsWith('member.password_reset')) events.push(e.type) })
    let res
    try {
      res = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    } finally { off() }
    expect(res!.statusCode, res!.body).toBe(204)

    expect(await verifyPassword(NEXT, (await storedHash(sub))!), 'the new password is stored').toBe(true)
    expect((await storedHash(sub)) === before, 'and it really changed').toBe(false)
    expect(await app.valkey.get(`sess:${live}`), 'every session went — a reset is what you do when someone else is in').toBeNull()
    expect(events, 'the completion is on the ledger').toContain('member.password_reset_completed')

    // consume-once
    const replay = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: 'yet-another-passphrase' } })
    expect(replay.statusCode, 'the link is spent').toBe(404)
    expect(await verifyPassword(NEXT, (await storedHash(sub))!), 'and the password it set still stands').toBe(true)
  }, 180_000)

  it('using one link invalidates the member OTHER live links', async () => {
    // Someone who asked three times and had one intercepted should not be leaving two more live.
    const { sub, identifier } = await makeLocalMember('multi')
    const first = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    const second = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    expect(await completePasswordReset(db, TEN, first.token, NEXT), 'the first works').not.toBeNull()
    expect(await completePasswordReset(db, TEN, second.token, 'a-third-passphrase-x'), 'the second is dead').toBeNull()
    expect(await verifyPassword(NEXT, (await storedHash(sub))!)).toBe(true)
  }, 180_000)

  it('an expired link is dead, and answers exactly like an unknown one', async () => {
    const { identifier } = await makeLocalMember('expired')
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    await adminPool`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(digest(${minted.token}, 'sha256'), 'hex')`
      .catch(async () => {
        // pgcrypto may not be installed; expire EVERY live row for this member instead — same state
        await adminPool`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`
      })
    const expired = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    const unknown = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: 'pwr_nothing', password: NEXT } })
    expect(expired.statusCode).toBe(404)
    expect(unknown.statusCode).toBe(404)
    expect(expired.json()).toEqual(unknown.json())
  }, 180_000)

  it('a password below the policy is refused, and the link SURVIVES', async () => {
    const { identifier } = await makeLocalMember('weak-reset')
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    const weak = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: 'short' } })
    expect(weak.statusCode).toBe(400)
    expect(weak.json()).toMatchObject({ code: 'weak_password' })
    const ok = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    expect(ok.statusCode, 'the person can still choose a longer one').toBe(204)
  }, 180_000)

  it('a cross-site POST can neither ask for nor complete a reset', async () => {
    const { identifier } = await makeLocalMember('csrf-reset')
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    const X = { ...H, 'sec-fetch-site': 'cross-site' }
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: X, payload: { identifier } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', headers: X, payload: { token: minted.token, password: NEXT } })).statusCode).toBe(403)
    expect(await completePasswordReset(db, TEN, minted.token, NEXT), 'and the link was not touched').not.toBeNull()
  }, 180_000)
})

describe('#568 review R1-R3: the reset surface itself', () => {
  it('R1: asking about an existing address costs the same TIME as asking about a stranger', async () => {
    // Measured on the first review: awaiting the SMTP send made this ~60ms for an address that
    // exists and ~2ms for one that does not. The status was uniform; the clock was the oracle.
    const { identifier } = await makeLocalMember('latency')
    const ask = async (id: string) => {
      const t = performance.now()
      const res = await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: H, payload: { identifier: id } })
      expect(res.statusCode).toBe(204)
      return performance.now() - t
    }
    // warm both paths first so module loading is not mistaken for the difference
    await ask(identifier); await ask(`warm-${STAMP}@e2e.test`)
    const real = Math.min(await ask(identifier), await ask(identifier))
    const ghost = Math.min(await ask(`ghost-lat-${STAMP}@e2e.test`), await ask(`ghost2-lat-${STAMP}@e2e.test`))
    // A send that is awaited shows up as an order of magnitude. Allow a generous 4x for noise.
    expect(real, `existing ${real.toFixed(1)}ms vs unknown ${ghost.toFixed(1)}ms`).toBeLessThan(Math.max(ghost * 4, ghost + 25))
  }, 180_000)

  it('R2: completing a reset clears only the OWNER lock, never one named in the body', async () => {
    // The defect this closes, measured on review: the unlock key came from an undeclared body field,
    // so any local member could complete their own reset while naming a victim and clear the
    // victim's lockout. Five guesses, a reset, five more — the §5 lockout was off for insiders.
    const victim = await makeLocalMember('r2-victim')
    const attacker = await makeLocalMember('r2-attacker')
    const lockKey = `lock:local:${TENANT}:${victim.identifier}`
    await app.valkey.set(lockKey, '1', 'EX', 120)

    const theirs = (await mintPasswordReset(db, { plan: 'free' }, attacker.identifier))!
    const res = await app.inject({
      method: 'POST', url: '/auth/local/reset', headers: H,
      payload: { token: theirs.token, password: NEXT, identifier: victim.identifier },
    })
    expect(res.statusCode, 'their own reset succeeds').toBe(204)
    expect(await app.valkey.get(lockKey), "and the victim's lock is untouched").not.toBeNull()

    // ...while the owner's own reset DOES clear their own lock
    const own = (await mintPasswordReset(db, { plan: 'free' }, victim.identifier))!
    await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: own.token, password: NEXT } })
    expect(await app.valkey.get(lockKey), 'the owner is let back in').toBeNull()
  }, 180_000)

  it('the reset events reach the EE ledger, not only the webhook stream (§6 C7)', async () => {
    const { drainAuditFor } = await import('./helpers/audit-drain.js')
    const { identifier, sub } = await makeLocalMember('audit')
    const count = async () => {
      await drainAuditFor(adminPool, TENANT)
      const [r] = await adminPool<[{ n: string }]>`
        SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`member:${sub}`}
          AND action IN ('member.password_reset_requested', 'member.password_reset_completed')`
      return Number(r.n)
    }
    const before = await count()
    await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: H, payload: { identifier } })
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    expect(await count() - before, 'both the request and the completion are on the ledger').toBeGreaterThanOrEqual(2)
  }, 180_000)
})

describe('#568 review F1/F2: the ledger says what happened, and does not say who', () => {
  it('F1: a password change that COMMITS always leaves a ledger line (same transaction)', async () => {
    // A separate transaction with a swallowed error can leave the password changed and the ledger
    // silent, which is the one state an investigation cannot recover from.
    const { drainAuditFor } = await import('./helpers/audit-drain.js')
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../auth/password-reset.ts', import.meta.url), 'utf8'))
    expect(src, 'the completion audits inside its own tx').toContain('auditIfEntitled(tx, tenant')
    const route = await import('node:fs').then((fs) => fs.readFileSync(new URL('../routes/auth-local.ts', import.meta.url), 'utf8'))
    expect(route, 'the change route wraps the UPDATE and the audit together').toMatch(/await req\.db\.tx\(async \(tx\) => \{[\s\S]*UPDATE local_credentials[\s\S]*auditIfEntitled\(tx/)

    // ...and the row really lands
    const { identifier, sub } = await makeLocalMember('f1')
    const minted = (await mintPasswordReset(db, { plan: 'free' }, identifier))!
    await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    await drainAuditFor(adminPool, TENANT)
    const rows = await adminPool<{ actor: string }[]>`
      SELECT actor FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`member:${sub}`} AND action = 'member.password_reset_completed'`
    expect(rows.length).toBeGreaterThan(0)
  }, 180_000)

  it('F2: the REQUEST is attributed to nobody — it is unauthenticated and anyone may type an address', async () => {
    // Recording the member as the actor would tell a takeover investigation that the owner asked for
    // this, which is the opposite of what the ledger knows.
    const { drainAuditFor } = await import('./helpers/audit-drain.js')
    const { identifier, sub } = await makeLocalMember('f2')
    await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: H, payload: { identifier } })
    await drainAuditFor(adminPool, TENANT)
    const rows = await adminPool<{ actor: string }[]>`
      SELECT actor FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`member:${sub}`} AND action = 'member.password_reset_requested'`
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.actor !== `user:${sub}`), 'never attributed to the member').toBe(true)
    expect(rows[0]!.actor).toBe('anonymous')
  }, 180_000)
})
