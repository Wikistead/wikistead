// #623 slice 12b, the sibling that was flagged and not fixed: the member list's cursor carries the
// timestamp as an ISO string, which stops at milliseconds.
//
// `created_at` is a `timestamptz` and Postgres keeps microseconds. `toISOString()` cannot, and a
// parameter cast back with `::timestamptz` rounds to what the string held. So the row that sits on a
// page boundary compares as GREATER than its own cursor and comes back on the next page. Measured on
// `/spaces` when the same bug was found there: seventeen rows walked, twelve distinct, five repeats.
//
// The pin walks the pages and compares the set against the truth. Duplicates and misses are both
// failures — a cursor that rounds the other way would drop a row instead, and reading only for repeats
// would call that a pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const LIKE = `mc623-%-${STAMP}`
const N = 9
const PAGE = 3

let app: FastifyInstance
let subs: string[] = []

const list = (cursor?: string) =>
  app.inject({
    method: 'GET',
    url: `/members?limit=${PAGE}&q=mc623-${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
  })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  subs = Array.from({ length: N }, (_, i) => `mc623-${String(i).padStart(2, '0')}-${STAMP}`)
  await seatMembers(admin, T, subs)
  await ensureMembers(T, subs)
  // The whole point: timestamps that differ ONLY below the millisecond. Written straight to the column
  // so the microseconds are real — a fixture built by inserting quickly would usually differ by more
  // than a microsecond and the bug would hide.
  for (const [i, sub] of subs.entries()) {
    // The offset is added IN SQL, from an integer parameter. Handing the driver a timestamp string
    // loses the microseconds on the way in — measured: nine rows written a microsecond apart all
    // landed on the same instant, and the fixture quietly stopped testing anything.
    await admin`
      UPDATE members
         SET created_at = '2026-03-01 00:00:00+00'::timestamptz + (${i} || ' microseconds')::interval
       WHERE tenant_id = ${T} AND sub = ${sub}`
  }
}, 180_000)

afterAll(async () => {
  const gone = (await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${T} AND sub LIKE ${LIKE}`)
    .map((r) => r.sub)
  if (gone.length) {
    await deleteTuples(fgaClient, memberTuples(T, gone)).catch(() => {})
    await unseatMembers(admin, T, gone).catch(() => {})
  }
  await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#623: the member cursor keeps the microseconds', () => {
  it('walking the pages returns every member exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await list(cursor)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json() as { members: { sub: string }[]; nextCursor: string | null }
      seen.push(...body.members.map((m) => m.sub))
      if (!body.nextCursor) break
      cursor = body.nextCursor
    }

    const mine = seen.filter((s) => s.startsWith('mc623-'))
    const distinct = new Set(mine)
    // Repeats: the row on the boundary compares as greater than its own truncated cursor.
    const repeats = mine.filter((s, i) => mine.indexOf(s) !== i)
    expect(repeats, `the walk returned these twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    // …and misses, which is how a cursor that rounded the other way would fail. Reading only for
    // repeats would call that a pass.
    expect(distinct.size, `walked ${mine.length} rows and saw ${distinct.size} of ${N} members`).toBe(N)
  }, 180_000)

  it('the cursor survives a round trip with its microseconds intact', async () => {
    // The mechanism, separate from the walk: whatever the response hands back must select the same
    // instant when it comes in again. A string that lost precision selects an earlier one, and the
    // boundary row lands on the wrong side of it.
    const first = await list()
    const body = first.json() as { members: { sub: string }[]; nextCursor: string | null }
    expect(body.nextCursor, 'the fixture is smaller than a page — nothing is being tested').toBeTruthy()

    const at = body.nextCursor!.slice(0, body.nextCursor!.indexOf('|'))
    const lastOnPage = body.members.at(-1)!.sub
    const [row] = await admin<{ same: boolean }[]>`
      SELECT (SELECT created_at FROM members WHERE tenant_id = ${T} AND sub = ${lastOnPage})
             = to_timestamp(${at}::numeric) AS same`
    expect(row!.same, `the cursor "${at}" does not name the instant it came from`).toBe(true)
  }, 180_000)
})
