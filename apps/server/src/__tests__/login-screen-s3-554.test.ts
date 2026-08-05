// #554 S3 / ADR-197 §3: /auth/login-options publishes the ordered CONNECTION list. Pins:
//   - {id, kind, label, brand} in sort order, minted opaque ids (never the tenant id);
//   - S1 drift (b) resolved: a listed-but-undecryptable connection is DROPPED (the screen must
//     never render a button the start route cannot honor) — and the endpoint answers 200, not 500;
//   - social slugs appear iff the platform connection is effective (the retired
//     socialProvidersFor "tenant OIDC wins → hide social" rule is gone: platform + social render
//     beside an own IdP now, and the SSO-enforcement pref still removes them);
//   - the legacy fields (methods/social) stay for pre-S3 clients, derived from the same list;
//   - labels stay null until S4 ships the column (rev3: no admin string on this surface yet).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { encryptSecret } from '../auth/secret-crypto.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `s3lo-${STAMP}`
const HOST = `${SLUG}.localhost`

let app: FastifyInstance
let tenantId = ''
// S3 review N5: the order pin must not coin-flip — sort 0 deliberately gets the lexicographically
// LARGER id, so dropping `sort` from the ORDER BY is guaranteed RED, not 50/50.
const [idSmall, idLarge] = [randomUUID(), randomUUID()].sort() as [string, string]
const connA = idLarge  // sort 0
const connB = idSmall  // sort 1
const connBroken = randomUUID()

const insert = async (id: string, sort: number, secretEnc: string | null) => {
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort)
    VALUES (${id}, ${tenantId}, 'https://idp.example', 'c', ${secretEnc}, 'openid', ${`http://${HOST}/auth/callback`}, true, ${sort})`
}
const options = async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/login-options', headers: { host: HOST } })
  expect(res.statusCode).toBe(200)
  return res.json() as { social?: string[]; methods: string[]; connections: { id: string; kind: string; label: string | null; brand: string | null }[] }
}

beforeAll(async () => {
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: `s3lo-admin-${STAMP}` } })
  tenantId = t.tenantId
  await insert(connA, 0, null)
  await insert(connB, 1, encryptSecret('a-real-secret'))
  await insert(connBroken, 2, 'not-a-valid-ciphertext')
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

describe('#554 S3: the login-options connection list', () => {
  it('publishes the ordered list with opaque ids and null labels; the broken connection is dropped, not a 500', async () => {
    const o = await options()
    expect(o.connections.map((c) => c.id)).toEqual([connA, connB])
    expect(o.connections.every((c) => c.kind === 'oidc' && c.label === null && c.brand === null)).toBe(true)
    // S6 review N6: the projection is the ONLY thing keeping server-internal connection attributes
    // (trustGroups, and formerly bootstrapEligible) off this unauthenticated surface — pin the exact key set.
    for (const c of o.connections) expect(Object.keys(c).sort()).toEqual(['brand', 'id', 'kind', 'label'])
    expect(o.connections.some((c) => c.id === tenantId), 'never the tenant id').toBe(false)
    expect(o.methods).toEqual(['oidc'])
    // #602: the `social` FIELD is retired — a provider is a preset connection in the list above, so
    // there is one thing for the screen to read. Asserting its absence is the point now.
    expect(o.social, 'the social field went with the path it described').toBeUndefined()
  }, 60_000)

  it('the PLATFORM connection appears beside an own IdP, and the SSO pref removes it', async () => {
    // RE-AIMED by #602: this measured "social rides the platform connection". Social is gone; the
    // connection it rode is what the screen offers now, so the subject narrows to the connection —
    // including the half that matters most, that the SSO preference still takes it away.
    process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
    process.env.PLATFORM_OIDC_CLIENT_ID = 'pc'
    process.env.PLATFORM_OIDC_REDIRECT_URI = `http://${HOST}/auth/callback`
    try {
      const o = await options()
      expect(o.connections[o.connections.length - 1], 'platform last').toMatchObject({ id: 'platform', kind: 'platform' })
      expect(o.connections.some((c) => c.kind === 'oidc'), 'the own IdP is offered too — the retired tenant-wins rule does not hide the platform beside it').toBe(true)

      await admin`INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled) VALUES (${tenantId}, true)
        ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = true`
      try {
        const enforced = await options()
        expect(enforced.connections.some((c) => c.kind === 'platform'), 'SSO enforcement drops the connection').toBe(false)
        expect(enforced.methods.includes('platform-oidc'), 'and the method with it').toBe(false)
      } finally {
        await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${tenantId}`
      }
    } finally {
      for (const k of ['PLATFORM_OIDC_ISSUER', 'PLATFORM_OIDC_CLIENT_ID', 'PLATFORM_OIDC_REDIRECT_URI']) delete process.env[k]
    }
  }, 60_000)
})
