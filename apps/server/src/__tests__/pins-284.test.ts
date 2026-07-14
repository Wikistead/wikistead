// #284 / ADR-119: member pins — the authz anti-tests. Real Postgres + OpenFGA + Valkey + Fastify.
//   - write is view-gated AND non-oracle: non-viewable, nonexistent and cross-tenant ids all
//     return the SAME uniform 404 (cross-tenant even WITH an FGA grant — RLS row-existence is
//     load-bearing, not just FGA);
//   - display re-confirms per pin (double gate): revoking view OR deleting the resource row
//     silently drops the pin while the member_pins row still exists (no title leak);
//   - member isolation is the app-level member_sub predicate: another member cannot read,
//     unpin, or reorder my pins (RLS alone is tenant-only);
//   - guests (share-link tokens) are structurally excluded (no guest opt-in → 401).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const TENANT = 'tenant_dev'
const SPACE = 'pin284-space'
const PAGE_A = 'pin284-page-a'       // viewable via space inheritance
const PAGE_B = 'pin284-page-b'       // viewable, then view revoked mid-suite (tuple removed)
const PAGE_C = 'pin284-page-c'       // viewable, then the ROW deleted (display gate 1)
const PAGE_HIDDEN = 'pin284-hidden'  // exists in-tenant, NO grants (uniform-404 case)
const ACME_SPACE = 'pin284-acme-space'
const ACME_PAGE = 'pin284-acme-page' // exists in ANOTHER tenant + alice HAS an FGA grant → RLS must still 404
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let app: FastifyInstance
const sids: Record<string, string> = {}
const H = (who: string) => ({ host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sids[who]}` })

const fgaFixture = [
  { user: 'user:pin-alice', relation: 'viewer_member', object: `space:${SPACE}` },
  { user: 'user:pin-bob', relation: 'viewer_member', object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE_A}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE_C}` },
  // PAGE_HIDDEN deliberately gets NO tuples. ACME_PAGE gets a DIRECT view grant for alice —
  // the cross-tenant 404 must come from the RLS row-existence gate, not from a missing grant.
  { user: 'user:pin-alice', relation: 'view_direct', object: `page:${ACME_PAGE}` },
]
// PAGE_B's space tuple is deleted mid-suite (the revoke case), so it is tracked separately.
const pageBTuple = [{ user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE_B}` }]

const listPins = async (who: string) => {
  const res = await app.inject({ method: 'GET', url: '/pins', headers: H(who) })
  expect(res.statusCode).toBe(200)
  return res.json() as { id: string; resourceType: string; resourceId: string; title: string; position: number; space?: { id: string; name: string; iconImageUrl: string | null } }[]
}
const pin = (who: string, resourceType: string, resourceId: string) =>
  app.inject({ method: 'POST', url: '/pins', headers: H(who), payload: { resourceType, resourceId } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Pin Space') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${ACME_SPACE}, 'tenant_acme', 'Acme Pin Space') ON CONFLICT (id) DO NOTHING`
  for (const [id, title] of [[PAGE_A, 'Pin A'], [PAGE_B, 'Pin B'], [PAGE_C, 'Pin C'], [PAGE_HIDDEN, 'Hidden']] as const) {
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${id}, ${TENANT}, ${SPACE}, ${title}, 'body', now()) ON CONFLICT (id) DO NOTHING`
  }
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${ACME_PAGE}, 'tenant_acme', ${ACME_SPACE}, 'Acme Page', 'body', now()) ON CONFLICT (id) DO NOTHING`
  for (const who of ['alice', 'bob']) {
    sids[who] = await createSession(valkey, { tenantId: TENANT, sub: `pin-${who}`, role: 'member' })
  }
  await writeTuples(fgaClient, [...fgaFixture, ...pageBTuple])
}, 60_000)

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, fgaFixture).catch(() => {})
  await deleteTuples(fgaClient, pageBTuple).catch(() => {})
  await admin`DELETE FROM member_pins WHERE member_sub LIKE 'pin-%'`.catch(() => {})
  await admin`DELETE FROM pages WHERE id LIKE 'pin284-%'`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id LIKE 'pin284-%'`.catch(() => {})
  await admin.end()
  await valkey.quit()
  await pool.end()
}, 60_000)

describe('#284 pin write gate (view-gated, non-oracle)', () => {
  it('pinning a viewable page succeeds and the pin lists with its CURRENT title', async () => {
    const res = await pin('alice', 'page', PAGE_A)
    expect(res.statusCode).toBe(201)
    const pins = await listPins('alice')
    const p = pins.find((x) => x.resourceId === PAGE_A)
    expect(p?.title).toBe('Pin A')
    // #284 a PAGE pin carries its owning space (name + icon) so the sidebar can disambiguate a deep
    // page. No icon_image_key on this space → iconImageUrl is null (initials chip on the client).
    expect(p?.space).toEqual({ id: SPACE, name: 'Pin Space', iconImageUrl: null })
  })

  it('re-pinning is idempotent (returns the existing pin, no duplicate row)', async () => {
    const again = await pin('alice', 'page', PAGE_A)
    expect(again.statusCode).toBe(201)
    const pins = await listPins('alice')
    expect(pins.filter((x) => x.resourceId === PAGE_A).length).toBe(1)
  })

  it('a space pin works the same way (per-id view check path)', async () => {
    expect((await pin('alice', 'space', SPACE)).statusCode).toBe(201)
    const pins = await listPins('alice')
    expect(pins.find((x) => x.resourceType === 'space' && x.resourceId === SPACE)?.title).toBe('Pin Space')
  })

  it('non-viewable, nonexistent and cross-tenant ids all return the SAME uniform 404', async () => {
    const hidden = await pin('alice', 'page', PAGE_HIDDEN)  // exists in-tenant, no view
    const missing = await pin('alice', 'page', 'pin284-no-such-page') // does not exist
    const acme = await pin('alice', 'page', ACME_PAGE)      // exists cross-tenant, WITH an FGA grant
    expect(hidden.statusCode).toBe(404)
    expect(missing.statusCode).toBe(404)
    expect(acme.statusCode).toBe(404) // RLS row-existence gate — the grant alone must not admit it
    expect(hidden.body).toBe(missing.body) // no oracle in the body either
  })
})

describe('#284 display gate (double condition, silent drop)', () => {
  it('revoking view drops the pin from the list while the row still exists (no title leak)', async () => {
    expect((await pin('alice', 'page', PAGE_B)).statusCode).toBe(201)
    expect((await listPins('alice')).some((x) => x.resourceId === PAGE_B)).toBe(true)
    await deleteTuples(fgaClient, pageBTuple) // revoke: the page falls out of the space inheritance
    expect((await listPins('alice')).some((x) => x.resourceId === PAGE_B)).toBe(false)
    const [row] = await admin`SELECT id FROM member_pins WHERE member_sub = 'pin-alice' AND resource_id = ${PAGE_B}`
    expect(row).toBeTruthy() // the stored row survives; only the DISPLAY gate hides it
  })

  it('deleting the resource ROW drops the pin (gate 1 — even though FGA tuples remain)', async () => {
    expect((await pin('alice', 'page', PAGE_C)).statusCode).toBe(201)
    await admin`DELETE FROM pages WHERE id = ${PAGE_C}` // simulate deletion that bypassed cleanup
    expect((await listPins('alice')).some((x) => x.resourceId === PAGE_C)).toBe(false)
  })
})

describe('#284 member isolation (app-level member_sub predicate)', () => {
  it("another member sees NONE of my pins", async () => {
    expect(await listPins('bob')).toEqual([])
  })

  it("another member cannot unpin my pin (same 404 as nonexistent)", async () => {
    const alicePin = (await listPins('alice')).find((x) => x.resourceId === PAGE_A)!
    const res = await app.inject({ method: 'DELETE', url: `/pins/${alicePin.id}`, headers: H('bob') })
    expect(res.statusCode).toBe(404)
    expect((await listPins('alice')).some((x) => x.id === alicePin.id)).toBe(true)
  })

  it("another member's reorder cannot move my pins", async () => {
    expect((await pin('alice', 'page', PAGE_B)).statusCode).toBe(404) // PAGE_B view was revoked above — still 404
    const before = (await listPins('alice')).filter((x) => x.resourceType === 'page').map((x) => x.id)
    const res = await app.inject({ method: 'PATCH', url: '/pins/reorder', headers: H('bob'), payload: { resourceType: 'page', orderedIds: [...before].reverse() } })
    expect(res.statusCode).toBe(204)
    const after = (await listPins('alice')).filter((x) => x.resourceType === 'page').map((x) => x.id)
    expect(after).toEqual(before) // bob's member_sub matched no rows
  })
})

describe('#284 reorder (v1 up/down persists position)', () => {
  it('reordering my own pins persists the new order', async () => {
    // alice re-pins a fresh second page so there are two orderable page pins.
    const extra = 'pin284-page-extra'
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${extra}, ${TENANT}, ${SPACE}, 'Pin Extra', 'body', now()) ON CONFLICT (id) DO NOTHING`
    const extraTuple = [{ user: `space:${SPACE}`, relation: 'space', object: `page:${extra}` }]
    await writeTuples(fgaClient, extraTuple)
    try {
      expect((await pin('alice', 'page', extra)).statusCode).toBe(201)
      const before = (await listPins('alice')).filter((x) => x.resourceType === 'page').map((x) => x.id)
      expect(before.length).toBeGreaterThanOrEqual(2)
      const reversed = [...before].reverse()
      const res = await app.inject({ method: 'PATCH', url: '/pins/reorder', headers: H('alice'), payload: { resourceType: 'page', orderedIds: reversed } })
      expect(res.statusCode).toBe(204)
      const after = (await listPins('alice')).filter((x) => x.resourceType === 'page').map((x) => x.id)
      expect(after).toEqual(reversed)
    } finally {
      await deleteTuples(fgaClient, extraTuple).catch(() => {})
    }
  })

  it('unpin removes my pin', async () => {
    const mine = (await listPins('alice')).find((x) => x.resourceId === PAGE_A)!
    const res = await app.inject({ method: 'DELETE', url: `/pins/${mine.id}`, headers: H('alice') })
    expect(res.statusCode).toBe(204)
    expect((await listPins('alice')).some((x) => x.resourceId === PAGE_A)).toBe(false)
  })
})

describe('#284 guests are structurally excluded (member-only routes)', () => {
  it('a share-link guest token gets 401 on every pin route (no guest opt-in)', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: 'pin284-link', resource: { type: 'space', id: SPACE }, capability: 'view' })
    const h = { host: 'dev.localhost', authorization: `Bearer ${tok}` }
    expect((await app.inject({ method: 'GET', url: '/pins', headers: h })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/pins', headers: h, payload: { resourceType: 'space', resourceId: SPACE } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: '/pins/whatever', headers: h })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: '/pins/reorder', headers: h, payload: { resourceType: 'page', orderedIds: [] } })).statusCode).toBe(401)
  })
})
