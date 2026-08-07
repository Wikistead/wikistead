// #623: two lines of the ledger, and they need opposite treatment.
//
// `/admin/sso-exemptions` is a real list — one row per exempted member, never pruned, growing with
// people. It gets a bound, and the walk is ASC: the direction that REPEATS rather than skips, so a
// boundary row compares as greater than the marker naming it and comes back on the next page. On
// `/members` that made the walk stop advancing entirely.
//
// `/admin/login-methods/impact` is NOT a list and never was. It answers two numbers, and its shape
// cannot grow with the tenant however many members are unsatisfied — the ledger called that debt, and
// this file measures the difference instead of arguing it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const SUBS = Array.from({ length: 9 }, (_, i) => `sso623-${STAMP}-${String(i).padStart(2, '0')}`)
const PAGE = 3
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance

const list = (cursor?: string) =>
  app.inject({
    method: 'GET',
    url: `/admin/sso-exemptions?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: H,
  })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  await seatMembers(admin, T, SUBS)
  for (const [i, sub] of SUBS.entries()) {
    // ⚠️ Offsets 0,1,2,3,4,5,5,7,8 put the tied pair at ASCENDING positions 6 and 7 — ACROSS the
    // boundary for PAGE = 3, which is the only place a missing tiebreaker can be seen. Measured the
    // wrong way first: with the pair at positions 5 and 6 it sits wholly inside page two, both rows
    // come back before the marker is taken, and deleting `member_sub` from the comparison stayed green.
    const offset = i === 6 ? 5 : i
    await admin`
      INSERT INTO sso_exemptions (tenant_id, member_sub, created_by, created_at)
      VALUES (${T}, ${sub}, 'dev-user', date_trunc('second', now()) + (${offset} || ' microseconds')::interval)
      ON CONFLICT DO NOTHING`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T} AND member_sub LIKE ${`sso623-${STAMP}-%`}`.catch(() => {})
  await unseatMembers(admin, T, SUBS).catch(() => {})
  await app.close(); await pool.end(); await admin.end()
}, 300_000)

const mine = (subs: string[]) => subs.filter((s) => s.startsWith(`sso623-${STAMP}-`))

describe('#623: the SSO-exemption list is bounded, and the walk loses nothing', () => {
  it('one response does not carry every exemption', async () => {
    const res = await list()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { exemptions: unknown[]; nextCursor: string | null }
    expect(body.exemptions.length).toBe(PAGE)
    expect(body.nextCursor, 'and it says there is more').toBeTruthy()
  }, 300_000)

  it('walking the pages returns every exemption exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 100; guard++) {
      const res = await list(cursor)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json() as { exemptions: { memberSub: string }[]; nextCursor: string | null }
      seen.push(...body.exemptions.map((e) => e.memberSub))
      if (!body.nextCursor) break
      cursor = body.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${SUBS.length}`)
      .toBe(SUBS.length)
    const truth = (await admin<{ member_sub: string }[]>`
      SELECT member_sub FROM sso_exemptions WHERE tenant_id = ${T} AND member_sub LIKE ${`sso623-${STAMP}-%`}
       ORDER BY created_at, member_sub`).map((r) => r.member_sub)
    expect(ours, 'the order survives the paging').toEqual(truth)
  }, 300_000)

  it('the marker names the instant it came from, microseconds included', async () => {
    const res = await list()
    const body = res.json() as { exemptions: { memberSub: string }[]; nextCursor: string }
    const at = body.nextCursor.slice(0, body.nextCursor.indexOf('|'))
    const lastSub = body.exemptions.at(-1)!.memberSub
    const [row] = await admin<{ same: boolean }[]>`
      SELECT (SELECT created_at FROM sso_exemptions WHERE tenant_id = ${T} AND member_sub = ${lastSub})
             = to_timestamp(${at}::numeric) AS same`
    expect(row!.same, `the marker "${at}" does not name the instant it came from`).toBe(true)
  }, 300_000)

  it('the login-methods impact answer is two numbers, whatever the tenant holds', async () => {
    // The ledger's other line, corrected rather than paid: this route reads every member to COUNT, and
    // the count is what it returns. Its shape cannot grow, so the fix was the classification.
    const res = await app.inject({ method: 'GET', url: '/admin/login-methods/impact?kinds=any', headers: H })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['signedOut', 'stance', 'unsatisfied'])
    expect(typeof body.unsatisfied, 'a COUNT, never the roster it counted').toBe('number')
    expect(typeof body.signedOut).toBe('number')
  }, 300_000)
})
