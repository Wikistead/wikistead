// #657 / ADR-219 §7: enrolling a second factor over HTTP.
//
// Driven through `app.inject` rather than against the store, because the things that can go wrong here
// are all at the boundary: whether a pending enrolment is visible before it is confirmed, whether an
// id belonging to somebody else can be confirmed, whether the same code works twice, and whether the
// limiter is reading the right counter. None of those are questions about SQL.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { totpCode, totpCounter, TOTP_STEP_SECONDS } from '../auth/totp.js'
import { FACTOR_VERIFY_MAX, MAX_FACTORS_PER_MEMBER } from '../routes/second-factor.js'
import { drainAuditFor } from './helpers/audit-drain.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
const factorIds: string[] = []

/** How many enrolments the ledger holds for this tenant right now. */
async function countEnrolments(): Promise<number> {
  await drainAuditFor(adminPool, TENANT)
  const [row] = await adminPool<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE tenant_id = ${TENANT} AND action = 'member.factor_enrolled'`
  return row?.n ?? 0
}

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: H, payload: JSON.stringify(body ?? {}) })

/** Start an enrolment as the dev-token member and remember it for cleanup. */
async function start(label?: string): Promise<{ factorId: string; secret: string; uri: string }> {
  const res = await post('/me/factors/totp', label ? { label } : {})
  expect(res.statusCode, res.body).toBe(201)
  const body = res.json() as { factorId: string; secret: string; uri: string }
  factorIds.push(body.factorId)
  return body
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
}, 180_000)

// Every test starts this member from nothing. There is a cap of MAX_FACTORS_PER_MEMBER and this file
// starts more enrolments than that between them, so without the reset the later tests fail on
// `factor_limit_reached` — which reads as a broken feature rather than as the file filling its own
// account. Measured: it did, twice, and the second time only the last test was left red.
beforeEach(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`
    .catch(() => {})
})

afterAll(async () => {
  for (const id of factorIds) {
    await adminPool`DELETE FROM member_factors WHERE id = ${id}`.catch(() => {})
  }
  // …and the member this file inserts directly, in case an assertion above never reached its own
  // cleanup. A stray seat is what pushed `tenant_dev` past its cap and reddened two unrelated files.
  await adminPool`DELETE FROM member_factors WHERE member_sub LIKE ${`f657-%`}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE sub LIKE ${`f657-%`}`.catch(() => {})
  // the limiter is keyed per member and this file deliberately trips it
  await app.valkey.del(`factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`).catch(() => {})
  await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#657: starting an enrolment', () => {
  it('hands back the secret once, with a URI a phone can read', async () => {
    const { secret, uri } = await start('work phone')
    expect(secret, 'base32, which is what an authenticator expects').toMatch(/^[A-Z2-7]+$/)
    expect(uri.startsWith('otpauth://totp/'), uri).toBe(true)
    expect(new URL(uri).searchParams.get('secret'), 'the URI carries the same secret').toBe(secret)
  }, 120_000)

  it('does not enrol anything — the list stays empty until it is confirmed', async () => {
    // The distinction this whole slice turns on. "Enrolled" must not mean "was shown a QR code": a
    // policy counting those would lock out everybody who scanned nothing.
    await start()
    const res = await app.inject({ method: 'GET', url: '/me/factors', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const listed = (res.json() as { factors: { id: string }[] }).factors.map((f) => f.id)
    for (const id of factorIds) expect(listed, `${id} is pending, not listed`).not.toContain(id)
  }, 120_000)
})

describe('#657: confirming', () => {
  it('takes a real code and puts the factor in the list', async () => {
    const { factorId, secret } = await start('confirmed one')
    const res = await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, Date.now()) })
    expect(res.statusCode, res.body).toBe(200)

    const list = (await app.inject({ method: 'GET', url: '/me/factors', headers: AUTH })).json() as {
      factors: { id: string; label: string; confirmedAt: string | null }[]
    }
    const mine = list.factors.find((f) => f.id === factorId)
    expect(mine, 'now it is a factor').toBeTruthy()
    expect(mine!.label).toBe('confirmed one')
    expect(mine!.confirmedAt).toBeTruthy()
  }, 120_000)

  it('each enrolment has its own secret, so one code opens exactly one of them', async () => {
    // Written as a replay test first, and it was measuring nothing: confirmation is one-shot, so the
    // same code cannot be presented to the same factor twice (the second attempt is 404, not a
    // replay), and a second enrolment has a different secret so the code is simply wrong for it.
    //
    // The REACHABLE replay — the same confirmed factor presented twice at sign-in, inside one window —
    // belongs to #652, which is where verification is asked more than once. What this slice can and
    // must show is that the counter is banked (below), so #652 starts from a floor rather than from
    // nothing.
    const first = await start()
    const code = totpCode(first.secret, Date.now())
    expect((await post(`/me/factors/${first.factorId}/confirm`, { code })).statusCode).toBe(200)

    const second = await start()
    const res = await post(`/me/factors/${second.factorId}/confirm`, { code })
    expect(res.statusCode, res.body).toBe(400)
    expect((res.json() as { code: string }).code, 'wrong for THIS secret').toBe('factor_code_invalid')
  }, 120_000)

  it('refuses a code from outside the window', async () => {
    const { factorId, secret } = await start()
    const stale = totpCode(secret, Date.now() - 3 * TOTP_STEP_SECONDS * 1000)
    const res = await post(`/me/factors/${factorId}/confirm`, { code: stale })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('factor_code_invalid')
  }, 120_000)

  it('refuses an id that is not the caller\'s, and says nothing about whether it exists', async () => {
    // Somebody else's pending enrolment, inserted directly: confirming it would hand them a factor
    // they never proved they hold.
    const otherSub = `f657-other-${STAMP}`
    await adminPool`
      INSERT INTO members (tenant_id, sub, email, role)
      VALUES (${TENANT}, ${otherSub}, ${`${otherSub}@e2e.test`}, 'member') ON CONFLICT DO NOTHING`
    const [row] = await adminPool<{ id: string }[]>`
      INSERT INTO member_factors (tenant_id, member_sub, kind) VALUES (${TENANT}, ${otherSub}, 'totp')
      RETURNING id`
    const theirs = row!.id

    const mine = await post(`/me/factors/${theirs}/confirm`, { code: '000000' })
    expect(mine.statusCode, 'not mine').toBe(404)
    const missing = await post('/me/factors/00000000-0000-0000-0000-000000000000/confirm', { code: '000000' })
    expect(missing.statusCode, 'and a row that does not exist answers identically').toBe(404)
    expect((mine.json() as { code: string }).code).toBe((missing.json() as { code: string }).code)

    await adminPool`DELETE FROM member_factors WHERE member_sub = ${otherSub}`
    await adminPool`DELETE FROM members WHERE sub = ${otherSub}`
  }, 120_000)

  it('confirming an already-confirmed factor is refused', async () => {
    const { factorId, secret } = await start()
    expect((await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, Date.now()) })).statusCode).toBe(200)
    // a fresh code, so this is about the factor's state and not about the counter
    const later = totpCode(secret, Date.now() + TOTP_STEP_SECONDS * 1000)
    const res = await post(`/me/factors/${factorId}/confirm`, { code: later })
    expect(res.statusCode, res.body).toBe(404)
  }, 120_000)
})

describe('#657: the limiter', () => {
  it('locks after the budget and answers 429 even to a correct code', async () => {
    // The lock has to be consulted BEFORE the code is looked at, or it is not a lock — a caller who
    // guesses right on attempt 200 would be let in.
    await app.valkey.del(`factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`)
    const { factorId, secret } = await start()

    for (let i = 0; i < FACTOR_VERIFY_MAX; i++) {
      const res = await post(`/me/factors/${factorId}/confirm`, { code: '000000' })
      expect(res.statusCode, `attempt ${i + 1} of ${FACTOR_VERIFY_MAX} is a plain refusal`).toBe(400)
    }
    const locked = await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, Date.now()) })
    expect(locked.statusCode, 'the right code, after the budget is gone').toBe(429)
    expect((locked.json() as { code: string }).code).toBe('factor_locked')

    await app.valkey.del(`factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`)
  }, 120_000)

  it('a success clears the window rather than shrinking it', async () => {
    await app.valkey.del(`factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`)
    const { factorId, secret } = await start()
    for (let i = 0; i < FACTOR_VERIFY_MAX - 1; i++) {
      await post(`/me/factors/${factorId}/confirm`, { code: '000000' })
    }
    expect((await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, Date.now()) })).statusCode).toBe(200)
    expect(await app.valkey.get(`factor:try:${TENANT}:dev-user`), 'the counter is gone').toBeNull()
  }, 120_000)
})

describe('#657: the ledger records getting a factor, not only losing one', () => {
  it('audits the enrolment with the actor', async () => {
    // ADR-219's acceptance names this: a ledger that records only the taking-away cannot answer "when
    // did this account get its factor" — the question asked once an account turns out to have been
    // reachable by somebody else.
    // A DELTA, not a count. `audit_log` is append-only and hash-chained, so rows this file wrote on a
    // previous run are still there — measured: with the audit call deleted entirely, a "> 0" assertion
    // stayed green off yesterday's rows. The ledger's own permanence is what made the pin vacuous.
    const before = await countEnrolments()
    const { factorId, secret } = await start()
    expect((await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, Date.now()) })).statusCode).toBe(200)

    await drainAuditFor(adminPool, TENANT)
    expect(await countEnrolments(), 'this enrolment reached the ledger').toBe(before + 1)
    const rows = await adminPool<{ actor: string }[]>`
      SELECT actor FROM audit_log
      WHERE tenant_id = ${TENANT} AND action = 'member.factor_enrolled' ORDER BY seq`
    expect(rows.at(-1)!.actor, 'with the actor').toBe('user:dev-user')
  }, 120_000)
})

describe('#657: the counter the store spends is the one the verifier matched', () => {
  it('spends the step the code belongs to', async () => {
    // The verifier returns WHICH counter matched precisely so this is not recomputed here. Asserted
    // against the database, because a route that spent `totpCounter(now)` regardless would look
    // identical from outside until somebody presents a code from the previous step.
    const { factorId, secret } = await start()
    const at = Date.now() - TOTP_STEP_SECONDS * 1000 // one step behind, still inside the window
    expect((await post(`/me/factors/${factorId}/confirm`, { code: totpCode(secret, at) })).statusCode).toBe(200)

    const [row] = await adminPool<{ last_counter: string }[]>`
      SELECT last_counter FROM member_totp_secrets WHERE factor_id = ${factorId}`
    expect(Number(row!.last_counter), 'the step the code came from, not the current one')
      .toBe(totpCounter(at))
  }, 120_000)
})

describe('#657: the list is bounded by a cap, not by a page', () => {
  // LAST in the file, and it clears the member's factors on both sides. Filling to the cap is the only
  // way to reach the refusal, and a filled account makes every other test in this file fail to start
  // one — measured: four of them went red on `factor_limit_reached` before this cleaned up.
  const wipe = () => adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`

  it('refuses an enrolment past the maximum', async () => {
    // #623's ledger caught this route as an unbounded list. The answer is a cap rather than paging:
    // a member who holds more authenticators than they can see would remove "all of them" and leave
    // the ones on page two.
    await wipe()
    // PENDING rows count too — an uncapped start would be an unbounded write even with a capped list,
    // so none of these are confirmed and the refusal must still come.
    for (let i = 0; i < MAX_FACTORS_PER_MEMBER; i++) await start(`fill ${i}`)

    const res = await post('/me/factors/totp', {})
    expect(res.statusCode, res.body).toBe(409)
    expect((res.json() as { code: string }).code).toBe('factor_limit_reached')
    await wipe()
  }, 180_000)
})
