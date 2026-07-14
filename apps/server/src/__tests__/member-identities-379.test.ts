// #379 / ADR-150: the member-identity resolver — the anti-tests the Review ratified. Real Postgres +
// Fastify. Pins: customized-only presence (present ⟺ member AND (override OR avatar)); the THREE absent
// classes (non-member / cross-tenant / un-customized member) are omitted IDENTICALLY (no membership
// oracle); displayName is never an email or email-local-part; guest/anon subs are dropped; the batch cap
// rejects; guests are structurally 401.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER_TENANT = 'tenant_acme'
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

// The identity matrix (unique to this file; cleaned up in afterAll).
const NAMED = 'id379-named'        // display_name_override set → resolves with the CHOSEN name
const AVATAR = 'id379-avatar'      // avatar only, email-ish OIDC display_name → resolves, name = IdP name (never email)
const PLAIN = 'id379-plain'        // member, NO override, NO avatar → omitted
const FOREIGN = 'id379-foreign'    // member of ANOTHER tenant (customized there) → omitted here
const GHOST = 'id379-ghost'        // not a member anywhere → omitted

let app: FastifyInstance

const resolve = (subs: unknown) =>
  app.inject({ method: 'POST', url: '/members/identities', headers: dev, payload: { subs } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, display_name_override) VALUES
    (${TENANT}, ${NAMED}, ${NAMED + '@e2e.test'}, 'member', 'IdP Name', 'Chosen Name') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, avatar_image_key) VALUES
    (${TENANT}, ${AVATAR}, ${AVATAR + '@e2e.test'}, 'member', 'Ava IdP', 'avatars/test-379.png') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name) VALUES
    (${TENANT}, ${PLAIN}, ${PLAIN + '@e2e.test'}, 'member', 'Plain Member') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name_override) VALUES
    (${OTHER_TENANT}, ${FOREIGN}, ${FOREIGN + '@e2e.test'}, 'member', 'Foreign Name') ON CONFLICT DO NOTHING`
}, 30_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE sub LIKE 'id379-%'`.catch(() => {})
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('POST /members/identities (#379 / ADR-150)', () => {
  it('resolves ONLY customized members; the three absent classes are omitted byte-identically', async () => {
    const r = await resolve([NAMED, AVATAR, PLAIN, FOREIGN, GHOST])
    expect(r.statusCode).toBe(200)
    const { identities } = r.json() as { identities: Record<string, { displayName: string | null; hasAvatar: boolean }> }
    expect(identities[NAMED]).toEqual({ displayName: 'Chosen Name', hasAvatar: false })
    expect(identities[AVATAR]).toEqual({ displayName: 'Ava IdP', hasAvatar: true }) // avatar-only → IdP name, never the email
    // no-oracle: un-customized member, cross-tenant member, non-member — all identically absent.
    expect(identities[PLAIN]).toBeUndefined()
    expect(identities[FOREIGN]).toBeUndefined()
    expect(identities[GHOST]).toBeUndefined()
    expect(Object.keys(identities).sort()).toEqual([AVATAR, NAMED].sort())
  })

  it('never returns an email or email-local-part as displayName', async () => {
    const r = await resolve([NAMED, AVATAR])
    const body = r.body
    expect(body).not.toContain('@e2e.test')
    expect(body).not.toContain(NAMED + '@')
    // the avatar-only member's IdP display_name is fine; their EMAIL never appears in any form.
  })

  it('drops guest:/anon: subs (never queried, never present)', async () => {
    const r = await resolve(['guest:abc-123', 'anon:7f3a1b2c3d4e', NAMED])
    const { identities } = r.json() as { identities: Record<string, unknown> }
    expect(Object.keys(identities)).toEqual([NAMED])
  })

  it('rejects an over-cap batch (bounded, not silent)', async () => {
    const r = await resolve(Array.from({ length: 201 }, (_, i) => `bulk-${i}`))
    expect(r.statusCode).toBe(400)
  })

  it('rejects a missing/invalid body', async () => {
    expect((await resolve(undefined)).statusCode).toBe(400)
    expect((await resolve('not-an-array')).statusCode).toBe(400)
  })

  it('a guest token is structurally 401 (no resolution on guest surfaces)', async () => {
    const tok = await mintGuestToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
      { tenantId: TENANT, shareLinkId: 'id379-link', resource: { type: 'page', id: 'demo' }, capability: 'view' },
    )
    const r = await app.inject({ method: 'POST', url: '/members/identities', headers: { host: 'dev.localhost', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, payload: { subs: [NAMED] } })
    expect(r.statusCode).toBe(401)
  })
})
