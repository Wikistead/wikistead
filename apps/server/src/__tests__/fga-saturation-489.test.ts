// #489 — the FGA-saturation fixes, pinned deterministically (no timing assertions):
//   1. filterAuthorized fans out BOUNDED (was one unbounded Promise.all: the title dictionary's
//      confirm pass handed it up to DICT_CAP=2000 ids → thousands of concurrent checks starved every
//      other route; measured 2ms /spaces → 3.2s, sidebar tree 4.4s, unrelated deadline 500s).
//   2. /pages/:id/title-dictionary gates on the ANCHOR page's view first — a nonexistent (or
//      non-viewable) id 404s after ONE check instead of running the full listObjects+confirm batch.
//   3. POST /pages/:id/view never 500s when the authz check itself ERRORS (FGA deadline) — the view
//      record is non-critical; skip + 204 (uniform for every page → no oracle; nothing recorded).
// 1 is pure (a counting fake FGA); 2–3 ride the real app (Postgres + OpenFGA + inject).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { clearTitleDictCache } from '../title-dict-cache.js'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, filterAuthorized } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const tag = Date.now().toString(36)

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `sat489-${tag}` })
  spaceId = space.id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: `sat489-page-${tag}` })).id
}, 40_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await pool.end()
}, 40_000)

describe('filterAuthorized — paced server-side BatchCheck (#489 fix 1 → #500 / ADR-183)', () => {
  // #534: the dictionary route caches per viewer for a few seconds. Without this, a pin that asks the
  // route a second time can be answered from the cache and stop proving whatever it was written to prove —
  // measured on this very file, where "healthy again" was served from the entry the degraded case warmed.
  beforeEach(() => clearTitleDictCache())
  it('runs ONE batch in flight at a time (never a store-monopolising burst), with identical semantics', async () => {
    // #500 / ADR-183 superseded the #489 per-id fan-out with server-side BatchCheck: O(N/50) round-trips
    // instead of O(N). The saturation guard is now "one batch in flight per caller" — the chunks run
    // sequentially, so at most ONE /batch-check is outstanding at any instant (was, before #489, 200
    // concurrent per-id checks; before ADR-183, 25). Semantics stay byte-identical.
    let inFlight = 0
    let maxInFlight = 0
    let batches = 0
    let checkCalls = 0
    const fake = {
      check: async () => { checkCalls++; return { allowed: true } },
      batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        batches++
        await new Promise((r) => setTimeout(r, 2)) // hold the slot so any overlap would be observable
        inFlight--
        return {
          result: body.checks.map((c) => ({
            allowed: Number(c.object.replace('page:p', '')) % 7 !== 0, // deny every 7th id
            request: c,
            correlationId: c.correlationId!,
          })),
        }
      },
    } as unknown as OpenFgaClient
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`)
    const out = await filterAuthorized(fake, 'user:u', 'view', ids)
    expect(out.size).toBe(ids.filter((_, i) => i % 7 !== 0).length) // allow/deny preserved
    expect(out.has('p8')).toBe(true)
    expect(out.has('p7')).toBe(false)
    expect(out.has('p14')).toBe(false)
    expect(batches).toBe(4) // 200 ids @ 50 = 4 chunks
    expect(checkCalls).toBe(0) // the BATCH path ran — no per-id check fan-out (nor a fallback)
    // THE pin: chunks are sequential, so only one /batch-check is ever outstanding.
    expect(maxInFlight).toBe(1)
  })
})

describe('title-dictionary anchor gate (#489 fix 2)', () => {
  it('a NONEXISTENT page id 404s (one check — never the full listObjects+confirm run)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/no-such-${tag}/title-dictionary`, headers: H })
    expect(res.statusCode).toBe(404) // RED before the fix: 200 + the caller's whole dictionary
  })

  it('a real, viewable page still gets the dictionary (the gate does not break the happy path)', async () => {
    // #534a cold call answers degraded-empty and kicks the background fill — the dictionary
    // arrives on a later call, so the happy path is pinned as "the fill lands", not "the first answer".
    type Dict = { entries: { id: string; title: string }[]; degraded?: boolean }
    let body: Dict | null = null
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: 'GET', url: `/pages/${pageId}/title-dictionary`, headers: H })
      expect(res.statusCode).toBe(200)
      const j = res.json() as Dict
      if (!j.degraded) { body = j; break }
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(body, 'the fill landed').not.toBeNull()
    expect(body!.entries.some((e) => e.id === pageId)).toBe(true) // the caller's own page is in their view set
  })
})

describe('title-dictionary DEGRADES under an ERRORING FGA (#489remedy 1)', () => {
  it('an FGA failure yields an empty 200 dictionary (degraded), never a 500 the client retries into', async () => {
    const original = app.fga.check.bind(app.fga)
    // page-scoped throw only — the auth/membership hooks also ride app.fga (the fix-3 lesson below)
    ;(app.fga as { check: unknown }).check = async (args: { object?: string }) => {
      if (String(args?.object ?? '').startsWith('page:')) throw new Error('rpc deadline exceeded')
      return original(args as never)
    }
    try {
      const res = await app.inject({ method: 'GET', url: `/pages/${pageId}/title-dictionary`, headers: H })
      expect(res.statusCode).toBe(200) // RED before the fix: 500 (and the HAR showed the client retrying it into ~6.5s)
      expect(res.json()).toMatchObject({ entries: [], capped: false, degraded: true })
    } finally {
      ;(app.fga as { check: unknown }).check = original
    }
    // healthy again: a clean non-viewable/nonexistent anchor still 404s (the gate is untouched)…
    const dead = await app.inject({ method: 'GET', url: `/pages/no-such-degrade-${tag}/title-dictionary`, headers: H })
    expect(dead.statusCode).toBe(404)
    // …and a real page gets a real (non-degraded) dictionary once the background fill lands (#534)
    let healthy = false
    for (let i = 0; i < 150 && !healthy; i++) {
      const ok = await app.inject({ method: 'GET', url: `/pages/${pageId}/title-dictionary`, headers: H })
      expect(ok.statusCode).toBe(200)
      if ((ok.json() as { degraded?: boolean }).degraded === undefined) healthy = true
      else await new Promise((r) => setTimeout(r, 200))
    }
    expect(healthy, 'FGA recovered and the fill served a real dictionary again').toBe(true)
  })
})

describe('POST /pages/:id/view under an ERRORING authz check (#489 fix 3)', () => {
  it('an FGA failure yields 204 (record skipped), never a 500 on the reading surface', async () => {
    const original = app.fga.check.bind(app.fga)
    // Surgical: fail ONLY page-object checks (the route's view gate). The auth/membership hooks also
    // go through app.fga — a blanket throw would 500 in the auth layer before the handler ever runs.
    ;(app.fga as { check: unknown }).check = async (args: { object?: string }) => {
      if (String(args?.object ?? '').startsWith('page:')) throw new Error('rpc deadline exceeded')
      return original(args as never)
    }
    try {
      const res = await app.inject({ method: 'POST', url: `/pages/${pageId}/view`, headers: H })
      expect(res.statusCode).toBe(204) // RED before the fix: 500
    } finally {
      ;(app.fga as { check: unknown }).check = original
    }
    // with FGA healthy again: a clean non-viewable/nonexistent id still 404s (existence-hiding floor)
    const after = await app.inject({ method: 'POST', url: `/pages/no-such-${tag}/view`, headers: H })
    expect(after.statusCode).toBe(404)
  })
})
