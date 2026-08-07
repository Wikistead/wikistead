// #623: the pending-invitation list arrived in one response. #638 boxed the UI and left the payload
// alone, so a tenant that has been inviting for a year sent all of them on every open of the members
// screen.
//
// The walk is DESC — the direction that SKIPS rather than repeats — and an invitation that appears on
// no page is one nobody can revoke or re-issue, which is exactly what #638 put on each row. So the walk
// is measured against the truth in the table for misses AND duplicates, with a tie ON a page boundary:
// inside one page both rows come back before the cursor is taken and the tiebreaker cannot be measured.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const N = 9
const PAGE = 3
const LIKE = `inv623-${STAMP}-%`

let app: FastifyInstance

const list = (cursor?: string) =>
  app.inject({
    method: 'GET',
    url: `/members/invites?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
  })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  await admin`DELETE FROM invites WHERE tenant_id = ${T} AND email LIKE ${LIKE}`
  for (let i = 0; i < N; i++) {
    // The offset is added IN SQL from an integer: a timestamp handed to the driver as a string loses
    // its microseconds on the way in, and the fixture then measures nothing. Offsets 8,7,6,6 put the
    // tied pair at descending positions 3 and 4 — the seam for PAGE = 3.
    const offset = i === 5 ? 6 : i
    await admin`
      INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, status, expires_at, created_at)
      VALUES (${T}, ${`inv623-${STAMP}-${String(i).padStart(2, '0')}@example.test`}, 'member', 'dev-user',
              ${`h-${STAMP}-${i}`}, 'pending', now() + interval '30 days',
              date_trunc('second', now()) + (${offset} || ' microseconds')::interval)`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM invites WHERE tenant_id = ${T} AND email LIKE ${LIKE}`.catch(() => {})
  await app.close(); await pool.end(); await admin.end()
}, 300_000)

const mine = (emails: string[]) => emails.filter((e) => e.startsWith(`inv623-${STAMP}-`))

describe('#623: the pending-invitation list is bounded, and the walk loses nothing', () => {
  it('one response does not carry every pending invitation', async () => {
    const res = await list()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { invites: { email: string }[]; nextCursor: string | null }
    expect(body.invites.length).toBe(PAGE)
    expect(body.nextCursor, 'and it says there is more').toBeTruthy()
  }, 300_000)

  it('walking the pages returns every invitation exactly once, newest first', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 40; guard++) {
      const res = await list(cursor)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json() as { invites: { email: string }[]; nextCursor: string | null }
      seen.push(...body.invites.map((i) => i.email))
      if (!body.nextCursor) break
      cursor = body.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${N}`).toBe(N)
    const truth = (await admin<{ email: string }[]>`
      SELECT email FROM invites WHERE tenant_id = ${T} AND email LIKE ${LIKE}
       ORDER BY created_at DESC, id DESC`).map((r) => r.email)
    expect(ours, 'the order survives the paging').toEqual(truth)
  }, 300_000)

  it('the cursor names the instant it came from, microseconds included', async () => {
    const res = await list()
    const body = res.json() as { invites: { email: string }[]; nextCursor: string }
    const at = body.nextCursor.slice(0, body.nextCursor.indexOf('|'))
    const lastEmail = body.invites.at(-1)!.email
    const [row] = await admin<{ same: boolean }[]>`
      SELECT (SELECT created_at FROM invites WHERE tenant_id = ${T} AND email = ${lastEmail})
             = to_timestamp(${at}::numeric) AS same`
    expect(row!.same, `the cursor "${at}" does not name the instant it came from`).toBe(true)
    const [distinct] = await admin<{ n: number }[]>`
      SELECT count(DISTINCT created_at)::int AS n FROM invites WHERE tenant_id = ${T} AND email LIKE ${LIKE}`
    // N - 1: one pair ties on purpose. Fewer means the microseconds were lost on write.
    expect(distinct!.n, 'the fixture collapsed to fewer instants').toBe(N - 1)
  }, 300_000)

  it('the response no longer contains the cursor column itself', async () => {
    // `cursor_at` is machinery, not an invitation field. It came back in the row until it was stripped.
    const res = await list()
    const body = res.json() as { invites: Record<string, unknown>[] }
    expect(Object.keys(body.invites[0]!), 'the cursor column leaked into the payload').not.toContain('cursor_at')
  }, 300_000)
})
