// #623: the custom-domain list returned every row, and each row costs a `passkeysStrandedBy` query —
// so an unbounded list was an unbounded FAN-OUT too, not only an unbounded payload.
//
// ⚠️ This one was grouped with the two connection lists and put behind a ruling, on the argument that a
// curated configuration list wants a cap rather than a page. Re-read: that argument rests on
// `/admin/connections` having a REORDER that takes every id, and on `/auth/login-options` being the
// sign-in screen, where hiding a way in behind "load more" is a broken sign-in. This route has neither.
// Grouping it with them was over-generalising, and paging it needs no ruling at all.
//
// The marker is the DOMAIN and there is no tiebreaker on purpose: the table is keyed by it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { listCustomDomains } from '../routes/custom-domains.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 7
const PAGE = 3
const DOMAINS = Array.from({ length: N }, (_, i) => `cd623-${STAMP}-${String(i).padStart(2, '0')}.example.test`)

let tenant: Tenant, db: TenantDb

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  for (const d of DOMAINS) {
    await admin`
      INSERT INTO custom_domains (tenant_id, domain, verification_token, status)
      VALUES (${tenant.id}, ${d}, ${`tok-${d}`}, 'pending')
      ON CONFLICT DO NOTHING`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${tenant.id} AND domain LIKE ${`cd623-${STAMP}-%`}`.catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const mine = (ds: string[]) => ds.filter((d) => d.startsWith(`cd623-${STAMP}-`))

describe('#623: the custom-domain list is bounded', () => {
  it('one response does not carry every domain', async () => {
    const first = await listCustomDomains(db, { limit: PAGE })
    expect(first.domains.length).toBe(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking returns every domain exactly once, in name order', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const page = await listCustomDomains(db, { limit: PAGE, ...(cursor ? { cursor } : {}) })
      seen.push(...page.domains.map((d) => d.domain))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(ours, 'the walk did not return them in their own order').toEqual([...DOMAINS].sort())
  }, 300_000)

  it('⚠️ the per-row passkey count rides the PAGE, not the whole table', async () => {
    // The half that is not about payload: `passkeysStrandedBy` runs once per row, so an unbounded list
    // was an unbounded fan-out. Bounding the rows bounds the queries with them.
    const page = await listCustomDomains(db, { limit: PAGE })
    expect(page.domains.length).toBe(PAGE)
    for (const d of page.domains) {
      expect(typeof d.passkeysStranded, 'the row lost the count the verify button reads').toBe('number')
    }
  }, 300_000)

  it('the last page does not claim there is more', async () => {
    const last = await listCustomDomains(db, { limit: 1000 })
    expect(last.nextCursor).toBeNull()
  }, 300_000)
})
