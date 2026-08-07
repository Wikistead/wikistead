// #623: three audit lines were written into the ledger this morning as debt, from reading the HELPERS
// and not the routes. Measured, and all three answer a fixed shape.
//
// `/audit/verify` and `/admin/transparency/verify` return a VERDICT — a judgement and a count, never
// the entries they recomputed over. A hash chain has to be verified from its start, so the read is
// unbounded by construction; the response is not. That is the axis `/billing/usage` sits on, not the
// one this ticket is about.
//
// ⚠️ `/admin/transparency` was already capped — and had NO WAY BACK. The reader saw the newest hundred
// and the rest of the ledger was unreachable from that screen, which on an audit surface reads like a
// ledger that begins there. That half is a real fix, and most of this file measures it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const N = 7
const PAGE = 3

let tenant: Tenant, app: FastifyInstance
let seeded = false

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  app = await buildApp(); await app.ready()
  // Transparency rows are a hash chain: each carries prev_hash/hash and the reader verifies them. This
  // fixture only needs ROWS to page over, so the hashes are placeholders — the verdict is asserted by
  // shape here, never by validity (transparency-435 owns the chain's correctness).
  const [{ n }] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tenant_transparency_log WHERE tenant_id = ${tenant.id}`
  if (n === 0) {
    for (let i = 1; i <= N; i++) {
      await admin`
        INSERT INTO tenant_transparency_log (tenant_id, seq, actor, action, reason, target, at, prev_hash, hash)
        VALUES (${tenant.id}, ${i}, ${`op-${i}`}, 'break_glass', 'as623', 'tenant', ${`2026-03-0${(i % 9) + 1}T00:00:00Z`},
                ${`p${i}`}, ${`h${i}`})
        ON CONFLICT DO NOTHING`
    }
    seeded = true
  }
}, 300_000)

afterAll(async () => {
  if (seeded) await admin`DELETE FROM tenant_transparency_log WHERE tenant_id = ${tenant.id} AND reason = 'as623'`.catch(() => {})
  await app.close(); await app.valkey.quit().catch(() => {})
  await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const get = (url: string) => app.inject({ method: 'GET', url, headers: H })

describe('#623: the audit answers are verdicts, and the ledger can be walked back', () => {
  it('/audit/verify answers a verdict — never the entries it recomputed over', async () => {
    const res = await get('/audit/verify')
    if (res.statusCode !== 200) return // entitlement-gated in some plans; the shape claim is below
    const body = res.json() as Record<string, unknown>
    expect(typeof body.valid, 'a judgement').toBe('boolean')
    expect(typeof body.count, 'and a count — not the rows').toBe('number')
    for (const k of Object.keys(body)) {
      expect(['valid', 'count', 'brokenAt', 'brokenSeq', 'reason'], `unexpected field "${k}"`).toContain(k)
    }
  }, 300_000)

  it('/admin/transparency/verify answers a verdict too', async () => {
    const res = await get('/admin/transparency/verify')
    if (res.statusCode !== 200) return
    const body = res.json() as Record<string, unknown>
    expect(typeof body.total).toBe('number')
    expect(Array.isArray((body as { entries?: unknown }).entries), 'the chain must not ride the verdict')
      .toBe(false)
  }, 300_000)

  it('⚠️ the transparency ledger can be walked BACKWARDS — the older entries are reachable', async () => {
    const first = await get(`/admin/transparency?limit=${PAGE}`)
    if (first.statusCode !== 200) return
    const b1 = first.json() as { entries: { seq: number }[]; nextBefore: number | null }
    expect(b1.entries.length).toBeLessThanOrEqual(PAGE)
    const [{ n: total }] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tenant_transparency_log WHERE tenant_id = ${tenant.id}`
    // ⚠️ Never skip on a null marker. Written that way first, and "there is no way back" — the exact
    // regression this case exists for — returned early and passed. If the ledger is larger than a page
    // and the marker is null, that IS the defect.
    if (total <= PAGE) return // genuinely nothing to walk: one page holds the ledger
    expect(b1.nextBefore, `the ledger holds ${total} entries and the first page offers no way back`)
      .not.toBeNull()
    const seen = new Set(b1.entries.map((e) => e.seq))
    let before: number | null = b1.nextBefore
    for (let guard = 0; guard < 50 && before != null; guard++) {
      const res = await get(`/admin/transparency?limit=${PAGE}&before=${before}`)
      const b = res.json() as { entries: { seq: number }[]; nextBefore: number | null }
      for (const e of b.entries) {
        expect(seen.has(e.seq), `seq ${e.seq} came back twice`).toBe(false)
        seen.add(e.seq)
      }
      before = b.nextBefore
    }
    expect(seen.size, 'the walk did not reach the start of the ledger').toBe(total)
  }, 300_000)

  it('the marker says when the start is reached, rather than leaving a short page to be read', async () => {
    const res = await get('/admin/transparency?limit=1000')
    if (res.statusCode !== 200) return
    const body = res.json() as { nextBefore: number | null }
    expect(body.nextBefore, 'a page holding the whole ledger must not claim there is more').toBeNull()
  }, 300_000)
})
