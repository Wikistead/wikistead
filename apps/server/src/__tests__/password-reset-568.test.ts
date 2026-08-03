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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
    expect(await mintPasswordReset(db, local.identifier), 'a password account gets a token').not.toBeNull()
    expect(await mintPasswordReset(db, oidc.email), 'an OIDC member has no credential to reset').toBeNull()
    expect(await mintPasswordReset(db, `nobody-${STAMP}@e2e.test`), 'a stranger, likewise').toBeNull()
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
    expect(await mintPasswordReset(db, local.identifier)).toBeNull()
    await setLocalLogin(true)
  }, 120_000)
})

describe('#568 §6: completing a reset', () => {
  it('replaces the password, kills every session, and cannot be replayed', async () => {
    const { sub, identifier } = await makeLocalMember('complete')
    const before = await storedHash(sub)
    const live = await createSession(app.valkey, { tenantId: TENANT, sub, email: identifier, role: 'member', groups: [] })
    const minted = (await mintPasswordReset(db, identifier))!

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
    const first = (await mintPasswordReset(db, identifier))!
    const second = (await mintPasswordReset(db, identifier))!
    expect(await completePasswordReset(db, first.token, NEXT), 'the first works').not.toBeNull()
    expect(await completePasswordReset(db, second.token, 'a-third-passphrase-x'), 'the second is dead').toBeNull()
    expect(await verifyPassword(NEXT, (await storedHash(sub))!)).toBe(true)
  }, 180_000)

  it('an expired link is dead, and answers exactly like an unknown one', async () => {
    const { identifier } = await makeLocalMember('expired')
    const minted = (await mintPasswordReset(db, identifier))!
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
    const minted = (await mintPasswordReset(db, identifier))!
    const weak = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: 'short' } })
    expect(weak.statusCode).toBe(400)
    expect(weak.json()).toMatchObject({ code: 'weak_password' })
    const ok = await app.inject({ method: 'POST', url: '/auth/local/reset', headers: H, payload: { token: minted.token, password: NEXT } })
    expect(ok.statusCode, 'the person can still choose a longer one').toBe(204)
  }, 180_000)

  it('a cross-site POST can neither ask for nor complete a reset', async () => {
    const { identifier } = await makeLocalMember('csrf-reset')
    const minted = (await mintPasswordReset(db, identifier))!
    const X = { ...H, 'sec-fetch-site': 'cross-site' }
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: X, payload: { identifier } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/auth/local/reset', headers: X, payload: { token: minted.token, password: NEXT } })).statusCode).toBe(403)
    expect(await completePasswordReset(db, minted.token, NEXT), 'and the link was not touched').not.toBeNull()
  }, 180_000)
})
