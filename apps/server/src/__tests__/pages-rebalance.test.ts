// #118: position-gap collapse detection + sibling re-spread. Pure helpers + a DB-level
// rebalance against real Postgres (RLS-scoped TenantDb).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { Tenant } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { spreadPositions, gapCollapsed, rebalanceSiblings, POSITION_STEP } from '../routes/pages.js'

describe('#118 position rebalance — pure helpers', () => {
  it('spreadPositions: evenly spaced, 1-based (nothing at 0)', () => {
    expect(spreadPositions(3)).toEqual([POSITION_STEP, 2 * POSITION_STEP, 3 * POSITION_STEP])
    expect(spreadPositions(0)).toEqual([])
  })

  it('gapCollapsed: true when the midpoint is not strictly between the neighbours', () => {
    expect(gapCollapsed(1, 2)).toBe(false) // room to bisect
    expect(gapCollapsed(1, 1)).toBe(true) // equal (duplicate) positions
    expect(gapCollapsed(1, 1 + Number.EPSILON)).toBe(true) // adjacent floats — exhausted
    expect(gapCollapsed(null, 5)).toBe(false) // an open end is never "collapsed"
    expect(gapCollapsed(5, null)).toBe(false)
  })
})

describe('#118 rebalanceSiblings (real Postgres, RLS)', () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
  let tenantId: string
  let db: TenantDb
  let spaceId: string

  beforeAll(async () => {
    ;({ tenantId } = await provisionTenant(fgaClient, { slug: `reb-${Date.now().toString(36)}`, admin: { sub: 'reb-owner' } }))
    db = await acquireTenantDb(asTenant(tenantId))
    ;[{ id: spaceId }] = await admin<[{ id: string }]>`
      INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, 'reb-space') RETURNING id`
    // Three top-level siblings ALL at the same position (a fully collapsed gap), distinguished
    // only by created_at order A < B < C.
    for (const [t, ms] of [['A', 0], ['B', 1], ['C', 2]] as const) {
      await admin`INSERT INTO pages (tenant_id, space_id, title, position, created_at)
                  VALUES (${tenantId}, ${spaceId}, ${t}, 1, now() + (${ms} || ' milliseconds')::interval)`
    }
  })

  afterAll(async () => {
    await admin`DELETE FROM pages WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM spaces WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
    await db.release()
    await admin.end()
    await pool.end()
  })

  it('re-spreads collapsed siblings to distinct, ordered positions (preserving order)', async () => {
    const fresh = await rebalanceSiblings(db.sql, spaceId, null, 'no-such-id')
    expect(fresh.map((s) => s.position)).toEqual([POSITION_STEP, 2 * POSITION_STEP, 3 * POSITION_STEP])

    const rows = await admin<{ title: string; position: number }[]>`
      SELECT title, position FROM pages WHERE tenant_id = ${tenantId} ORDER BY position`
    // distinct + strictly increasing, and the original A<B<C order is preserved
    expect(rows.map((r) => r.title)).toEqual(['A', 'B', 'C'])
    expect(new Set(rows.map((r) => r.position)).size).toBe(3)
  })
})
