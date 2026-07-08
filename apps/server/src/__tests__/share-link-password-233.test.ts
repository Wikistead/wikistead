// #233 / ADR-107: share-link password protection. Security-critical (the anonymous-guest boundary).
// The password gate runs LAST — after every dead-state + the authoritative FGA check — so a dead link is a
// uniform 404 that never reveals a password, wrong ≡ missing (no oracle), and a correct password never
// bumps the wrong-password throttle. Real Postgres + OpenFGA + Fastify.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { createShareLink, mintTokenForShareLink } from '../routes/share-links.js'
import { hashSharePassword, verifySharePassword } from '../routes/share-link-password.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, spaceId: string, pageId: string, app: FastifyInstance

const mkLink = (opts: { password?: string | null }) =>
  createShareLink(db, fgaClient, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null, password: opts.password ?? null })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'slpw-space' })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Locked' })).id
  app = await buildApp(); await app.ready()
}, 60_000)
afterAll(async () => {
  await app.close()
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 60_000)

describe('#233 scrypt hash', () => {
  it('verifies the correct password and rejects a wrong / malformed one (constant-time)', async () => {
    const h = await hashSharePassword('hunter2')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifySharePassword('hunter2', h)).toBe(true)
    expect(await verifySharePassword('wrong', h)).toBe(false)
    expect(await verifySharePassword('hunter2', null)).toBe(false)
    expect(await verifySharePassword('hunter2', 'garbage')).toBe(false)
  })
})

describe('#233 mint password gate (3-way)', () => {
  it('a non-password link mints a token (regression: byte-identical path)', async () => {
    const link = await mkLink({})
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).not.toBe('password_required')
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).not.toBeNull()
  })
  it('a password link: correct → token; wrong ≡ missing → password_required (no oracle)', async () => {
    const link = await mkLink({ password: 's3cret' })
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, 's3cret')).not.toBe('password_required')
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, 'nope')).toBe('password_required')
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).toBe('password_required') // missing
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, '')).toBe('password_required')
  })
  it('a REVOKED password link is a uniform null (404) — never password_required (existence-hidden)', async () => {
    const link = await mkLink({ password: 's3cret' })
    await admin`UPDATE share_links SET revoked_at = now() WHERE id = ${link.id}`
    // even WITH the correct password, a revoked link is dead → null, not password_required.
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, 's3cret')).toBeNull()
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, 'nope')).toBeNull()
  })
  it('an EXPIRED password link is a uniform null (404), never password_required', async () => {
    const link = await mkLink({ password: 's3cret' })
    await admin`UPDATE share_links SET expires_at = now() - interval '1 hour' WHERE id = ${link.id}`
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, 's3cret')).toBeNull()
  })
})

describe('#233 wrong-password throttle (HTTP)', () => {
  it('trips at the 5-per-(link,IP)/min limit; a wrong password 401s until then, then 429', async () => {
    const link = await mkLink({ password: 's3cret' })
    const post = (password?: string) => app.inject({
      method: 'POST', url: `/public/share-links/${link.id}/token`,
      headers: { host: 'dev.localhost', 'content-type': 'application/json' },
      payload: password === undefined ? {} : { password },
    })
    // 5 wrong attempts return 401 password_required (within the window).
    for (let i = 0; i < 5; i++) {
      const r = await post('wrong')
      expect(r.statusCode, `attempt ${i + 1}`).toBe(401)
      expect(r.json()).toEqual({ error: 'password_required' })
    }
    // the 6th is throttled — the dedicated wrong-password bucket is at its max.
    const sixth = await post('wrong')
    expect(sixth.statusCode).toBe(429)
    // even the CORRECT password is 429 while the window is tripped (cools down after).
    expect((await post('s3cret')).statusCode).toBe(429)
  })
})
