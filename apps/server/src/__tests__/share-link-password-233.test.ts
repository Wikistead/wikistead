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
import { hashSharePassword, needsSharePasswordRehash, parseSharePassword, verifySharePassword } from '../routes/share-link-password.js'
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { check, writeTuples } from '@wikistead/authz'
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
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 's3cret' })).not.toBe('password_required')
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 'nope' })).toBe('password_required')
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).toBe('password_required') // missing
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: '' })).toBe('password_required')
  })
  it('a REVOKED password link is a uniform null (404) — never password_required (existence-hidden)', async () => {
    const link = await mkLink({ password: 's3cret' })
    await admin`UPDATE share_links SET revoked_at = now() WHERE id = ${link.id}`
    // even WITH the correct password, a revoked link is dead → null, not password_required.
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 's3cret' })).toBeNull()
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 'nope' })).toBeNull()
  })
  it('an EXPIRED password link is a uniform null (404), never password_required', async () => {
    const link = await mkLink({ password: 's3cret' })
    await admin`UPDATE share_links SET expires_at = now() - interval '1 hour' WHERE id = ${link.id}`
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 's3cret' })).toBeNull()
  })
})

// #986 / ADR-107 correction: rows written before the parameters were raised must keep opening their
// link, and must be rewritten at today's parameters the one moment the plaintext is in hand. Driven
// through `mintTokenForShareLink` — the shipped door — rather than the KDF functions, because the
// upgrade is a WRITE and the pure functions cannot see whether anybody performs it.
describe('#986 the below-floor record opens the link, then upgrades in place', () => {
  it('a legacy two-field hash mints a token and is rewritten to the parameterised form', async () => {
    const link = await mkLink({ password: 's3cret' })
    // Exactly what the pre-#986 code stored: node's default parameters, two fields, no N/r/p.
    const salt = randomBytes(16)
    const legacy = `scrypt$${salt.toString('hex')}$${((await promisify(scryptCb)('s3cret', salt, 32)) as Buffer).toString('hex')}`
    await admin`UPDATE share_links SET password_hash = ${legacy} WHERE id = ${link.id}`

    const minted = await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 's3cret' })
    expect(minted, 'the visitor is NOT locked out by the raise').not.toBe('password_required')
    expect(minted).not.toBeNull()

    // The upgrade is best-effort and runs on the entry path, so poll rather than assume it landed
    // before the token was returned.
    let stored = legacy
    for (let i = 0; i < 40 && stored === legacy; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const [row] = await admin<{ password_hash: string }[]>`SELECT password_hash FROM share_links WHERE id = ${link.id}`
      stored = row!.password_hash
    }
    expect(stored, 'rewritten at the current parameters').not.toBe(legacy)
    expect(parseSharePassword(stored)!.N, 'and the new record states them').toBeGreaterThanOrEqual(131072)
    expect(needsSharePasswordRehash(stored), 'so it is not due another upgrade').toBe(false)
    expect(await verifySharePassword('s3cret', stored), 'and the same password still opens it').toBe(true)
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 'nope' })).toBe('password_required')
  }, 60_000)
})

describe('#233 space-link password ⊥ private page (ADR-107 required integration test)', () => {
  it('a space-link guest with the CORRECT password still cannot view a private page (#244 pair marker)', async () => {
    // A published, PRIVATE page in the space (both markers — the #244 pair; page#space so it would
    // otherwise inherit space-viewer).
    const priv = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Private in space' })).id
    await admin`UPDATE pages SET published_md = 'secret', published_at = now() WHERE id = ${priv}`
    await writeTuples(fgaClient, [
      { user: `space:${spaceId}`, relation: 'space', object: `page:${priv}` },
      { user: 'user:*', relation: 'private', object: `page:${priv}` },
      { user: 'share_link:*', relation: 'private', object: `page:${priv}` },
    ])
    // A SPACE share link WITH a password.
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', resource: { type: 'space', id: spaceId }, capability: 'view', expiresInSeconds: null, password: 'openplease' })
    // The correct password mints a token (the password gate passes)...
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id, { password: 'openplease' })).not.toBe('password_required')
    // ...but the space-link guest STILL cannot view the private page — password protects the space, it does
    // not grant private pages. #244's share_link:* private marker cuts the space-viewer inheritance.
    expect(await check(fgaClient, `share_link:${link.id}`, 'view', { type: 'page', id: priv })).toBe(false)
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

  it('the prompt-display path (no-password POST) never consumes the budget — no 1-typo lockout', async () => {
    // review #233 ShareRoute first POSTs with NO password to discover the link needs
    // one (React StrictMode double-fires it), so counting those 401s exhausted the 5/min bucket on
    // the very first load. A dedicated IP isolates this link's buckets from the other HTTP tests.
    const link = await mkLink({ password: 's3cret' })
    const ip = '10.60.60.1'
    const post = (password?: string) => app.inject({
      method: 'POST', url: `/public/share-links/${link.id}/token`,
      headers: { host: 'dev.localhost', 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: password === undefined ? {} : { password },
    })
    // Several prompt-display loads (a StrictMode double-fire plus a reload) — all 401, none counted.
    for (let i = 0; i < 3; i++) expect((await post()).statusCode, `prompt ${i + 1}`).toBe(401)
    // The user STILL has the full 5 wrong-attempt budget: 5 SUBMITTED wrong passwords 401 …
    for (let i = 0; i < 5; i++) expect((await post('wrong')).statusCode, `wrong ${i + 1}`).toBe(401)
    // … and only the 6th SUBMITTED wrong password trips 429 (the prompt loads did not eat into it).
    expect((await post('wrong')).statusCode).toBe(429)
  })
})
