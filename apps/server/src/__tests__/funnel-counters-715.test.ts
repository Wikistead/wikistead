// #715 / ADR-229 §6: the funnel counts what it says, records nobody, and counts nothing in CE.
//
// The privacy claim is the point of this file, and it is asserted by SHAPE rather than by reading
// the collector: the report functions take no arguments, so there is nothing a future collector
// could persist about a visitor, and the table's column set is exactly the two counters plus a
// date — a column added later turns this red, which is the whole reason it is pinned.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool } from '../db/pool.js'
import {
  reportLinkVisit, reportWorkspaceCreated, registerFunnelCollector, resetFunnelCollector, funnelRegistered,
} from '../funnel/sink.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)

afterEach(() => resetFunnelCollector())
afterAll(async () => { await admin.end(); await pool.end() }, 30_000)

describe('#715: the funnel seam', () => {
  it('CE default: reporting is a no-op and nothing is registered', () => {
    expect(funnelRegistered(), 'a self-hosted build must count nothing at all').toBe(false)
    // The calls still run — the routes are not conditional on a Cloud build.
    expect(() => { reportLinkVisit(); reportWorkspaceCreated() }).not.toThrow()
  })

  it('registered: each report reaches the collector exactly once', () => {
    let visits = 0
    let created = 0
    registerFunnelCollector({ linkVisit: () => { visits++ }, workspaceCreated: () => { created++ } })
    reportLinkVisit()
    reportLinkVisit()
    reportWorkspaceCreated()
    expect([visits, created]).toEqual([2, 1])
  })

  it('a collector that throws cannot break the product', () => {
    registerFunnelCollector({
      linkVisit: () => { throw new Error('collector down') },
      workspaceCreated: () => { throw new Error('collector down') },
    })
    // A share-link exchange and a signup must not fail because a counter did.
    expect(() => { reportLinkVisit(); reportWorkspaceCreated() }).not.toThrow()
  })

  it('the report signatures carry NO identifier — the privacy promise is structural', () => {
    // `length` is the declared arity. Zero means a future collector cannot be handed a visitor id,
    // a tenant, an IP or a page, because the call sites have nothing to give it.
    expect(reportLinkVisit.length, 'reportLinkVisit must take no arguments').toBe(0)
    expect(reportWorkspaceCreated.length, 'reportWorkspaceCreated must take no arguments').toBe(0)
    const src = readFileSync(resolve(import.meta.dirname, '../funnel/sink.ts'), 'utf8')
    expect(src, 'the collector interface must stay argument-free too').toMatch(/linkVisit\(\):\s*void/)
    expect(src).toMatch(/workspaceCreated\(\):\s*void/)
  })

  it('the table holds a date and two counts, and nothing else', async () => {
    const cols = await admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'funnel_daily' ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual(['day', 'link_visits', 'workspaces_created'])
  }, 30_000)

  it('the call sites are the two the ADR names, and only those', () => {
    const root = resolve(import.meta.dirname, '..')
    const shareLinks = readFileSync(resolve(root, 'routes/share-links.ts'), 'utf8')
    const signup = readFileSync(resolve(root, 'routes/signup.ts'), 'utf8')
    // The denominator counts a MINTED token: a dead, revoked or password-refused link never reached
    // the product, so it is not a visit.
    expect(shareLinks).toMatch(/if \(minted && minted !== 'password_required'\) reportLinkVisit\(\)/)
    expect(signup).toMatch(/reportWorkspaceCreated\(\)/)
  })
})
