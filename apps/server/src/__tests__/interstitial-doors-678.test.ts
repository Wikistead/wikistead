// #678 / ADR-222 §6: a key can be made at the door, and both session-less doors owe what the session
// ones already paid.
//
// The circle: the policy denies a session to anybody holding nothing, so the doors on the factor
// receipt are the only way to get a first factor. While the only one minted TOTP, a `passkey` stance
// was a state nobody could leave, and the switch had to refuse it. This is the slice that makes the
// capability true instead of banning the word.
//
// The other half is a hole #677 measured and did not fix: those doors had no per-member cap, no discard
// of abandoned enrolments, and no rate limit on the START (only on the confirm). One receipt could
// create unbounded pending rows, each one a slot against a cap the member cannot see — #653's trap
// arriving by another road. Adding a second door in the same shape would have doubled it.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { FACTOR_COOKIE } from '../auth/factor-session.js'
import { MAX_FACTORS_PER_MEMBER } from '../routes/second-factor.js'
import { interstitialCanMint, INTERSTITIAL_MINTS } from '../auth/factor-policy.js'
import { hashPassword } from '../auth/password-hash.js'
import { ensureMembers } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HOST = 'dev.localhost'
const PASSWORD = 'a password for the 678 doors'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
let priorLocalLogin = false
const emails: string[] = []

const setStance = (kinds: string) => admin`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
  VALUES (${T}, ${kinds !== 'off'}, ${kinds}, TRUE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${kinds !== 'off'}, second_factor_kinds = ${kinds}, local_login_enabled = TRUE`

async function memberWithPassword(name: string): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_p678-${name}-${STAMP}`
  const email = `p678-${name}-${STAMP}@e2e.test`
  emails.push(email)
  await admin`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${email}, 'member')
    ON CONFLICT (tenant_id, sub) DO NOTHING`
  await admin`
    INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
    VALUES (${T}, ${sub}, ${email}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  await ensureMembers(T, [sub])
  return { sub, email }
}

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: H, payload: JSON.stringify({ identifier, password: PASSWORD }) })

const receiptFor = async (email: string): Promise<string> => {
  const res = await signIn(email)
  return res.cookies.find((c) => c.name === FACTOR_COOKIE)!.value
}

const startEnrol = (fsid: string, path: 'enrol' | 'enrol/passkey') =>
  app.inject({
    method: 'POST', url: `/auth/local/factor/${path}`,
    headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
  })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  const [pref] = await admin<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${T}`
  priorLocalLogin = pref?.local_login_enabled ?? false
}, 180_000)

beforeEach(async () => {
  await setStance('off')
  // The start-side limiter counts per member, and these cases share subs across runs of the file.
  for (const email of emails) {
    const [m] = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${T} AND email = ${email}`
    if (m) await app.valkey.del(`authlocal:enrol:${m.sub}`).catch(() => {})
  }
})

afterAll(async () => {
  await admin`
    UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off',
      local_login_enabled = ${priorLocalLogin} WHERE tenant_id = ${T}`.catch(() => {})
  for (const email of emails) {
    const mine = admin`SELECT sub FROM members WHERE tenant_id = ${T} AND email = ${email}`
    await admin`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${T} AND member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND email = ${email}`.catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#678: the door can mint a passkey', () => {
  it('a member with nothing enrolled is issued registration options under a `passkey` stance', async () => {
    // Before this slice the same request answered 409 `factor_kind_not_accepted` — the honest refusal
    // #677 left, and the one this ticket exists to remove.
    const { email } = await memberWithPassword('mint')
    await setStance('passkey')
    const res = await startEnrol(await receiptFor(email), 'enrol/passkey')
    expect(res.statusCode, res.body).toBe(201)
    const body = res.json<{ factorId: string; options: { challenge?: string; rp?: { id?: string } } }>()
    expect(body.factorId, 'a pending row was created').toBeTruthy()
    expect(body.options.challenge, 'and a challenge was banked with it').toBeTruthy()
    expect(body.options.rp?.id, 'for THIS host — a key made elsewhere cannot answer here').toBe(HOST)
  }, 180_000)

  it('…and the TOTP door refuses under that stance, pointing at the one that works', async () => {
    // Both doors exist now, so the refusal is a signpost rather than a dead end.
    const { email } = await memberWithPassword('totp-under-pk')
    await setStance('passkey')
    const res = await startEnrol(await receiptFor(email), 'enrol')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_kind_not_accepted')
  }, 180_000)

  it('the passkey door refuses under a `totp` stance', async () => {
    // The mirror. Without it, a door that ignored the stance entirely would pass the case above.
    const { email } = await memberWithPassword('pk-under-totp')
    await setStance('totp')
    const res = await startEnrol(await receiptFor(email), 'enrol/passkey')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_kind_not_accepted')
  }, 180_000)
})

describe('#678: both doors inherit the cap, the discard and the limit', () => {
  it('an abandoned enrolment is discarded rather than banked against the cap', async () => {
    // The hole: one receipt, repeated starts, unbounded pending rows — each a slot against a cap the
    // member cannot see. Measured as ROWS rather than as a later 409, because the 409 arrives ten
    // abandoned attempts later and by then the account is stuck.
    const { sub, email } = await memberWithPassword('discard')
    await setStance('any')
    const fsid = await receiptFor(email)
    for (let i = 0; i < 3; i++) expect((await startEnrol(fsid, 'enrol')).statusCode).toBe(201)

    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM member_factors WHERE member_sub = ${sub}`
    expect(row!.n, 'three starts leave ONE pending row, not three').toBe(1)
  }, 180_000)

  it('the cap is refused here too, not only on the settings doors', async () => {
    // Reaching the cap AT THIS DOOR needs the population ADR-222 §3 is about: somebody whose factors
    // all fail the stance, so they are sent to enrol (`enrolled` is false) while their rows still hold
    // slots. Filling with factors that DO count would be refused one guard earlier — "present the one
    // you have" — and the case would pass for the wrong reason (measured: it did).
    const { sub, email } = await memberWithPassword('cap')
    await setStance('passkey')
    for (let i = 0; i < MAX_FACTORS_PER_MEMBER; i++) {
      await admin`
        INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
        VALUES (${T}, ${sub}, 'totp', ${`full-${i}`}, now())`
    }
    const res = await startEnrol(await receiptFor(email), 'enrol/passkey')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_limit_reached')
  }, 180_000)

  it('the START is rate limited, not only the confirm', async () => {
    // The cheap half was unlimited: a receipt could ask for options as fast as it liked, and only the
    // expensive half — presenting a code — was counted.
    const { email } = await memberWithPassword('limit')
    await setStance('any')
    const fsid = await receiptFor(email)
    let locked = 0
    for (let i = 0; i < 40; i++) {
      const res = await startEnrol(fsid, 'enrol')
      if (res.statusCode === 429) { locked++; break }
    }
    expect(locked, 'the door stops answering before forty attempts').toBe(1)
  }, 180_000)
})

describe('#678: the switch guard resolves itself', () => {
  it('`interstitialCanMint` is true for every stance now that both doors exist', () => {
    for (const stance of ['off', 'any', 'passkey', 'totp'] as const) {
      expect(interstitialCanMint(stance), `${stance} is reachable`).toBe(true)
    }
  })

  it('…and it is false for a stance whose kinds no door mints', () => {
    // The control the predicate exists for, and it has to run THE FUNCTION. The first version of this
    // case built a local empty array and asserted `[].some(...)` is false — a true statement about
    // Array.prototype, not about `interstitialCanMint`. Measured: replacing the whole predicate with
    // `() => true` left all twenty-one assertions in this file and #676's green. A guard nothing
    // observes is the decoration a deleted named-value ban leaves behind, which is the exact failure
    // ADR-222 §6 chose a predicate to avoid.
    //
    // Driven by emptying what the doors mint, because that is the real way this goes false: a door is
    // removed, or a stance is added whose kinds no door can make. The list is restored afterwards —
    // it is module state shared with every other case here.
    const real = [...INTERSTITIAL_MINTS]
    try {
      INTERSTITIAL_MINTS.length = 0
      for (const stance of ['any', 'passkey', 'totp'] as const) {
        expect(interstitialCanMint(stance), `${stance} claims to be reachable with no doors at all`).toBe(false)
      }
      // `off` too: it accepts every kind, so with nothing mintable it is equally unreachable. (The
      // switch never asks about `off` — turning the requirement off strands nobody — but the predicate
      // must not answer from the stance NAME.)
      expect(interstitialCanMint('off'), 'answered from the name rather than from the doors').toBe(false)

      // …and one door is enough for the stance that accepts it, but not for the other.
      INTERSTITIAL_MINTS.push('totp')
      expect(interstitialCanMint('totp'), 'a TOTP door makes a TOTP stance reachable').toBe(true)
      expect(interstitialCanMint('passkey'), 'a TOTP door does not make a passkey stance reachable').toBe(false)
    } finally {
      INTERSTITIAL_MINTS.length = 0
      INTERSTITIAL_MINTS.push(...real)
    }
  })

  it('the list matches the doors that actually exist', () => {
    // `INTERSTITIAL_MINTS` is a claim about `auth-local.ts`, and a claim in another file goes stale
    // silently. This reads the routes: every kind named must have a session-less door, and every such
    // door must be named.
    const routes = readFileSync(resolve(import.meta.dirname, '../routes/auth-local.ts'), 'utf8')
    const hasTotpDoor = /'\/auth\/local\/factor\/enrol'/.test(routes)
    const hasPasskeyDoor = /'\/auth\/local\/factor\/enrol\/passkey'/.test(routes)
    expect(hasTotpDoor, 'the TOTP door is registered').toBe(true)
    expect(hasPasskeyDoor, 'the passkey door is registered').toBe(true)
    expect([...INTERSTITIAL_MINTS].sort(), 'and the list says exactly those').toEqual(['passkey', 'totp'])
  })
})
