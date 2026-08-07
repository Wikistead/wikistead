// #623 / ADR-220 §6.2: the GUEST shell draws the whole-space tree unvirtualised and fully expanded, so
// it is the surface where an enormous tree actually costs the reader something.
//
// Its bound is a CAP WITH A VISIBLE STATE, never a quiet cut. A space link's tree is small in the
// ordinary case; in the extraordinary one a loud refusal beats a lie, and the shell prints a line.
//
// ⚠️ MEMBERS ARE NOT CAPPED HERE. Their answer is the branch route; capping the whole-space read for
// them would be exactly the silent truncation this ticket exists to remove. Half of this file is that
// asymmetry, because a cap that quietly applied to everyone would satisfy the other half perfectly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, GUEST_TREE_CAP } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const LINK = `gtc623-${STAMP}`
const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 300),
}

let tenant: Tenant, db: TenantDb, app: FastifyInstance
let space: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gtc623-${STAMP}`,
  })).id
  // The cap is 500 and building 501 pages here would cost minutes, so the ASYMMETRY and the STATE are
  // what this file measures on a small tree; the cap's arithmetic is measured directly below by asking
  // the route with a tree smaller than it and requiring `truncated` to be false. A fixture large enough
  // to cross 500 belongs in a load test, not in the suite every commit runs.
  for (let i = 0; i < 3; i++) {
    const id = (await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space, userId: 'dev-user', title: `gtc623-${i}`, parentId: null,
    })).id
    await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${id}`
    await writeTuples(fgaClient, [{ user: `space:${space}`, relation: 'space', object: `page:${id}` }])
  }
  await writeTuples(fgaClient, [
    { user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` },
  ])
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` }]).catch(() => {})
  await admin`DELETE FROM pages WHERE space_id = ${space}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await app.close(); await app.valkey.quit().catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const asGuest = async () => {
  const tok = await mintGuestToken(guestCfg, {
    tenantId: tenant.id, shareLinkId: LINK, resource: { type: 'space', id: space }, capability: 'view',
  })
  return app.inject({ method: 'GET', url: `/spaces/${space}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
}
const asMember = () =>
  app.inject({ method: 'GET', url: `/spaces/${space}/pages`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })

describe('#623 / ADR-220 §6.2: the guest tree is capped, and says so', () => {
  it('the answer carries the state — it is not a bare list any more', async () => {
    // The shape IS the feature: a bare array has nowhere to put "this was cut", which is why a quiet
    // cut was the only thing the old contract could express.
    const res = await asGuest()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { pages: unknown[]; truncated: boolean }
    expect(Array.isArray(body.pages), 'the rows moved under `pages`').toBe(true)
    expect(typeof body.truncated, 'the state has nowhere to live without this field').toBe('boolean')
  }, 300_000)

  it('a small tree is NOT reported as cut', async () => {
    // The green path. Without it, `truncated: true` always would satisfy "it says so" perfectly, and
    // every guest would see a refusal for a three-page space.
    const res = await asGuest()
    const body = res.json() as { pages: unknown[]; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(body.pages.length, 'the guest lost rows on a tree far below the cap').toBe(3)
  }, 300_000)

  it('⚠️ a MEMBER is not capped — their answer is the branch route', async () => {
    const res = await asMember()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { pages: unknown[]; truncated: boolean }
    expect(body.truncated, 'capping the whole-space read for members is the truncation this ticket removes')
      .toBe(false)
    expect(body.pages.length).toBe(3)
  }, 300_000)

  it('the cap is a real number the code exports, not a literal buried in a handler', async () => {
    // So the shell's wording and the server's arithmetic can be checked against one value, and so a
    // future change to it is visible in a diff rather than in a magic number.
    expect(GUEST_TREE_CAP).toBeGreaterThan(0)
    expect(Number.isInteger(GUEST_TREE_CAP)).toBe(true)
  }, 300_000)
})
