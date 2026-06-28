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

  // #116 review (the owner point 3): the trigger is SECURITY INVOKER, so the prune DELETE
  // runs as the INSERTING role under RLS — and BOTH real revision-insert paths (publish via
  // req.db, restore via pool.begin+set_config) insert as the app role, NOT the admin/superuser
  // the tests above use. (The collab auto-save path does NOT insert revisions — storeYdoc only
  // UPDATEs pages.ydoc per ADR-019, so there is no third path.) Inserting as superuser bypasses
  // RLS and the GRANTs, so it would NOT catch a missing DELETE grant on the app role — which
  // would make publish/restore throw in production when the trigger fires. Insert as the app
  // role here to prove the prune actually works on the path the app uses.
  it('prunes under the APP role + tenant RLS (SECURITY INVOKER has DELETE on the real path)', async () => {
    const [{ id: appPage }] = await admin<[{ id: string }]>`
      INSERT INTO pages (tenant_id, space_id, title)
      SELECT ${tenantId}, space_id, 'AppRole' FROM pages WHERE id = ${pageId} RETURNING id`
    const extra = 3
    const ydoc = Buffer.from([1, 2, 3])
    // Insert via the APP-role pool with the tenant RLS context set (exactly like publish/restore).
    await pool.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      for (let i = 0; i < KEEP + extra; i++) {
        await tx`
          INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_at)
          VALUES (${tenantId}, ${appPage}, ${ydoc}, ${'a' + i}, now() + (${i} || ' seconds')::interval)`
      }
    })
    // If the app role lacked DELETE on revisions, the trigger would have errored above; reaching
    // here AND seeing exactly KEEP proves the SECURITY INVOKER prune works under app-role RLS.
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${appPage}`
    expect(n).toBe(KEEP)
  })
})
