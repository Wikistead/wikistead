// #489 — the FGA-saturation fixes, pinned deterministically (no timing assertions):
//   1. filterAuthorized fans out BOUNDED (was one unbounded Promise.all: the title dictionary's
//      confirm pass handed it up to DICT_CAP=2000 ids → thousands of concurrent checks starved every
//      other route; measured 2ms /spaces → 3.2s, sidebar tree 4.4s, unrelated deadline 500s).
//   2. /pages/:id/title-dictionary gates on the ANCHOR page's view first — a nonexistent (or
//      non-viewable) id 404s after ONE check instead of running the full listObjects+confirm batch.
//   3. POST /pages/:id/view never 500s when the authz check itself ERRORS (FGA deadline) — the view
//      record is non-critical; skip + 204 (uniform for every page → no oracle; nothing recorded).
// 1 is pure (a counting fake FGA); 2–3 ride the real app (Postgres + OpenFGA + inject).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

describe('filterAuthorized — bounded fan-out (#489 fix 1)', () => {
  it('never exceeds the concurrency bound, with identical semantics', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let total = 0
    const fake = {
      check: async ({ object }: { object: string }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        total++
        await new Promise((r) => setTimeout(r, 2)) // hold the slot so overlap is observable
        inFlight--
        // deny every 7th id — the result set must reflect exactly the allowed ones
        return { allowed: Number(object.replace('page:p', '')) % 7 !== 0 }
      },
    } as unknown as OpenFgaClient
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`)
    const out = await filterAuthorized(fake, 'user:u', 'view', ids)
    expect(total).toBe(200) // every id checked exactly once
    expect(out.size).toBe(ids.filter((_, i) => i % 7 !== 0).length) // allow/deny preserved
    expect(out.has('p8')).toBe(true)
    expect(out.has('p7')).toBe(false)
    expect(out.has('p14')).toBe(false)
    // THE pin: before the fix this was 200 (one unbounded Promise.all) — the saturation mechanism.
    expect(maxInFlight).toBeLessThanOrEqual(25)
  })
})

describe('title-dictionary anchor gate (#489 fix 2)', () => {
  it('a NONEXISTENT page id 404s (one check — never the full listObjects+confirm run)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/no-such-${tag}/title-dictionary`, headers: H })
    expect(res.statusCode).toBe(404) // RED before the fix: 200 + the caller's whole dictionary
  })

  it('a real, viewable page still gets the dictionary (the gate does not break the happy path)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${pageId}/title-dictionary`, headers: H })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { entries: { id: string; title: string }[] }
    expect(Array.isArray(body.entries)).toBe(true)
    expect(body.entries.some((e) => e.id === pageId)).toBe(true) // the caller's own page is in their view set
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
    // …and a real page gets a real (non-degraded) dictionary
    const ok = await app.inject({ method: 'GET', url: `/pages/${pageId}/title-dictionary`, headers: H })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { degraded?: boolean }).degraded).toBeUndefined()
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
