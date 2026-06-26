// #116: revisions are pruned to the last N per page by the AFTER INSERT trigger (migration
// 027). Real Postgres. The cap is a per-page COUNT bound (distinct from time-based retention).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const KEEP = 200 // must match migration 027
let tenantId: string
let pageId: string

beforeAll(async () => {
  ;({ tenantId } = await provisionTenant(fgaClient, { slug: `prune-${Date.now().toString(36)}`, admin: { sub: 'prune-owner' } }))
  const [{ id: spaceId }] = await admin<[{ id: string }]>`
    INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, 'prune-space') RETURNING id`
  ;[{ id: pageId }] = await admin<[{ id: string }]>`
    INSERT INTO pages (tenant_id, space_id, title) VALUES (${tenantId}, ${spaceId}, 'P') RETURNING id`
})

afterAll(async () => {
  await admin`DELETE FROM revisions WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#116 revision pruning (keep last N per page)', () => {
  it(`keeps only the newest ${KEEP} revisions; oldest are pruned on insert`, async () => {
    const extra = 5
    const ydoc = Buffer.from([1, 2, 3])
    // Insert KEEP + extra revisions with strictly increasing created_at so "newest" is
    // deterministic. Each INSERT fires the trigger, which prunes back to KEEP.
    for (let i = 0; i < KEEP + extra; i++) {
      await admin`
        INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_at)
        VALUES (${tenantId}, ${pageId}, ${ydoc}, ${'r' + i}, now() + (${i} || ' seconds')::interval)`
    }
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`
    expect(n).toBe(KEEP) // capped, not KEEP+extra

    // The oldest `extra` (r0..r4) are gone; the newest survive (r{KEEP+extra-1} present).
    const titles = (await admin<{ title: string }[]>`SELECT title FROM revisions WHERE page_id = ${pageId}`).map((r) => r.title)
    expect(titles).not.toContain('r0')
    expect(titles).not.toContain('r' + (extra - 1)) // r4
    expect(titles).toContain('r' + (KEEP + extra - 1)) // newest kept
  })

  it('does not touch another page revisions (prune is per-page)', async () => {
    const [{ id: other }] = await admin<[{ id: string }]>`
      INSERT INTO pages (tenant_id, space_id, title)
      SELECT ${tenantId}, space_id, 'Other' FROM pages WHERE id = ${pageId} RETURNING id`
    await admin`INSERT INTO revisions (tenant_id, page_id, ydoc, title) VALUES (${tenantId}, ${other}, ${Buffer.from([9])}, 'solo')`
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${other}`
    expect(n).toBe(1) // unaffected by the other page hitting the cap
  })
})
