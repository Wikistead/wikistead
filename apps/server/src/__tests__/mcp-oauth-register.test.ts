// #311 / ADR-131 slice 2: RFC 7591 DCR for the MCP authorization server. Validates the redirect_uri allowlist
// (pure) and the public-client registration (real Postgres via acquireTenantDb — the backlinks.test teardown
// pattern that does NOT hang). No token machinery here (slice 2 is register-only).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { validateRedirectUris, registerClient } from '../routes/mcp-oauth-register.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb

beforeAll(async () => { db = await acquireTenantDb(asTenant(TENANT)) }, 30_000)
afterAll(async () => {
  await admin`DELETE FROM mcp_oauth_clients WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 30_000)

describe('validateRedirectUris (#311 / ADR-131 slice 2)', () => {
  it('accepts https and http loopback; rejects other schemes, non-loopback http, fragments, non-arrays', () => {
    expect(validateRedirectUris(['https://claude.ai/callback'])).toEqual(['https://claude.ai/callback'])
    expect(validateRedirectUris(['http://localhost:8080/cb', 'http://127.0.0.1/x'])).toHaveLength(2)
    expect(() => validateRedirectUris([])).toThrow() // empty
    expect(() => validateRedirectUris('https://x/cb')).toThrow() // not an array
    expect(() => validateRedirectUris(['http://evil.example.com/cb'])).toThrow() // http, non-loopback
    expect(() => validateRedirectUris(['ftp://x/y'])).toThrow() // other scheme
    expect(() => validateRedirectUris(['not a uri'])).toThrow() // relative/garbage
    expect(() => validateRedirectUris(['https://x/cb#frag'])).toThrow() // fragment
    expect(() => validateRedirectUris([42])).toThrow() // non-string entry
  })
})

describe('registerClient (#311 / ADR-131 slice 2)', () => {
  it('registers a PUBLIC client, persists it tenant-bound with no secret, returns RFC 7591 fields', async () => {
    const r = await registerClient(db, TENANT, { redirect_uris: ['https://claude.ai/callback'], client_name: 'Claude' }, 1_700_000_000_000)
    expect(r.client_id).toMatch(/^mcp_/)
    expect(r.redirect_uris).toEqual(['https://claude.ai/callback'])
    expect(r.token_endpoint_auth_method).toBe('none') // public client — no secret is issued
    expect(r.client_name).toBe('Claude')
    expect(r.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(r.client_id_issued_at).toBe(1_700_000_000)
    // persisted under THIS tenant (RLS) — the table has no client_secret column at all.
    const [row] = await admin<{ tenant_id: string; redirect_uris: string[]; token_endpoint_auth_method: string }[]>`
      SELECT tenant_id, redirect_uris, token_endpoint_auth_method FROM mcp_oauth_clients WHERE client_id = ${r.client_id}`
    expect(row!.tenant_id).toBe(TENANT)
    expect(row!.redirect_uris).toEqual(['https://claude.ai/callback'])
    expect(row!.token_endpoint_auth_method).toBe('none')
  })

  it('rejects a confidential client (only token_endpoint_auth_method=none is supported) before persisting', async () => {
    await expect(registerClient(db, TENANT, { redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'client_secret_basic' }, Date.now()))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an invalid redirect_uri (http non-loopback) before persisting', async () => {
    const before = (await admin<{ n: string }[]>`SELECT count(*) AS n FROM mcp_oauth_clients WHERE tenant_id = ${TENANT}`)[0]!.n
    await expect(registerClient(db, TENANT, { redirect_uris: ['http://evil.example.com/cb'] }, Date.now()))
      .rejects.toMatchObject({ statusCode: 400 })
    const after = (await admin<{ n: string }[]>`SELECT count(*) AS n FROM mcp_oauth_clients WHERE tenant_id = ${TENANT}`)[0]!.n
    expect(after).toBe(before) // nothing persisted on a validation failure
  })
})
