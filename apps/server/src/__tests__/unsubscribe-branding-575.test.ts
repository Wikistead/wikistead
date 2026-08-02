// #575 / ADR-200 slice B: the unsubscribe page names the workspace being left — safely.
//
// This page is the reason the escaping rule in ADR-200 is a rule and not a preference. It is a RAW HTML
// template (not React), served from the API origin — the same origin as the BFF session cookie
// (ADR-016). The tenant display name reaching it is stored with a trim and a length cap and no
// sanitiser, and any tenant admin can set it. Interpolating it unescaped there is stored XSS aimed at
// the session surface, from a value the product invites people to type.
//
// Uses tenant_acme rather than tenant_dev so that mutating a shared tenant's branding cannot race
// branding.test.ts, which asserts tenant_dev's exact branding row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { mintUnsubToken } from '@wikistead/auth'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const TENANT = 'tenant_acme'
const STAMP = Date.now().toString(36)
const SUB = `unsub575-${STAMP}`
const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const host = { host: 'acme.localhost' }
const HOSTILE = '<script>alert(1)</script> "Acme"'

let app: FastifyInstance
let db: TenantDb
let restore: string | null = null

const setName = (n: string | null) => db.sql`
  INSERT INTO tenant_settings (tenant_id, display_name, updated_at) VALUES (${TENANT}, ${n}, now())
  ON CONFLICT (tenant_id) DO UPDATE SET display_name = ${n}, updated_at = now()`

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb({ id: TENANT, slug: 'acme', plan: 'business', isolation: 'logical' } as Tenant)
  const [row] = await db.sql<{ display_name: string | null }[]>`SELECT display_name FROM tenant_settings LIMIT 1`
  restore = row?.display_name ?? null
  await db.sql`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${SUB}, ${SUB}, ${`${SUB}@t.test`})`
}, 120_000)

afterAll(async () => {
  await setName(restore).catch(() => {})
  await db.sql`DELETE FROM members WHERE sub = ${SUB}`.catch(() => {})
  await db.release(); await app.close(); await pool.end()
}, 120_000)

const get = async (action: 'immediate' | 'digest') => {
  const token = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action })
  return app.inject({ method: 'GET', url: `/email/unsubscribe?token=${encodeURIComponent(token)}`, headers: host })
}

describe('#575: the unsubscribe page wears the workspace name', () => {
  it('shows the tenant display name', async () => {
    await setName('Acme Wiki')
    const page = await get('immediate')
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Acme Wiki')
    expect(page.body, 'and still offers the POST, which is the only thing that flips a pref').toContain('<form method="post"')
  }, 120_000)

  it('falls back to the product name when the tenant has not set one', async () => {
    await setName(null)
    const page = await get('digest')
    expect(page.body).toContain('Wikistead')
  }, 120_000)

  it('ESCAPES it — this page shares an origin with the session cookie', async () => {
    await setName(HOSTILE)
    const page = await get('immediate')
    expect(page.body, 'a stored name must not become markup here').not.toContain('<script>alert(1)</script>')
    expect(page.body).toContain('&lt;script&gt;')
    expect(page.body, 'nor break out of the <title>/attribute it sits in').toContain('&quot;Acme&quot;')
  }, 120_000)

  it('escapes it on the POST result page too — the flip is not the end of the render', async () => {
    await setName(HOSTILE)
    const token = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action: 'digest' })
    const res = await app.inject({
      method: 'POST', url: `/email/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).toContain('&lt;script&gt;')
  }, 120_000)
})
