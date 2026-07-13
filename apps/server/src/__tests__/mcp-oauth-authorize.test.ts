// #311 / ADR-131 slice 3a: the authorize-request VALIDATION layer (open-redirect defense + PKCE S256 + scope).
// The validation is pure (fake client object); resolveClient hits real Postgres (register → resolve).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { registerClient } from '../routes/mcp-oauth-register.js'
import {
  resolveClient, validateAuthorizeRequest, AuthorizeDirectError, AuthorizeRedirectError, type OAuthClient,
} from '../routes/mcp-oauth-authorize.js'
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

const client: OAuthClient = { clientId: 'mcp_x', redirectUris: ['https://claude.ai/cb', 'http://localhost:9000/cb'] }
const ok = { clientId: 'mcp_x', redirectUri: 'https://claude.ai/cb', responseType: 'code', codeChallenge: 'abc123', codeChallengeMethod: 'S256', scope: 'read write', state: 's1' }

describe('validateAuthorizeRequest — open-redirect defense (#311 / ADR-131 slice 3a)', () => {
  it('accepts a well-formed request (exact redirect, S256 PKCE, known scopes)', () => {
    const v = validateAuthorizeRequest(client, ok)
    expect(v.redirectUri).toBe('https://claude.ai/cb')
    expect(v.codeChallenge).toBe('abc123')
    expect(v.scopes).toEqual(['read', 'write'])
    expect(v.state).toBe('s1')
  })

  it('an UNKNOWN client is a DIRECT error — never redirected', () => {
    expect(() => validateAuthorizeRequest(null, ok)).toThrow(AuthorizeDirectError)
  })

  it('a redirect_uri that is not EXACTLY registered is a DIRECT error (no substring/prefix/trailing-slash)', () => {
    for (const bad of ['https://claude.ai/cb/', 'https://claude.ai', 'https://claude.ai/cb?x=1', 'https://evil.com/cb', 'https://claude.ai.evil.com/cb']) {
      expect(() => validateAuthorizeRequest(client, { ...ok, redirectUri: bad }), bad).toThrow(AuthorizeDirectError)
    }
  })

  it('a bad response_type / missing-or-plain PKCE / bad scope is a REDIRECT error (redirect_uri is confirmed)', () => {
    const cases = [
      { ...ok, responseType: 'token' },
      { ...ok, codeChallenge: undefined },
      { ...ok, codeChallengeMethod: 'plain' },
      { ...ok, scope: 'read admin' },
    ]
    for (const c of cases) {
      let err: unknown
      try { validateAuthorizeRequest(client, c) } catch (e) { err = e }
      expect(err).toBeInstanceOf(AuthorizeRedirectError)
      expect((err as AuthorizeRedirectError).redirectUri).toBe('https://claude.ai/cb')
      expect((err as AuthorizeRedirectError).state).toBe('s1') // state echoed back for CSRF binding
    }
  })

  it('defaults scope to read when omitted', () => {
    expect(validateAuthorizeRequest(client, { ...ok, scope: undefined }).scopes).toEqual(['read'])
  })
})

describe('resolveClient (#311 / ADR-131 slice 3a)', () => {
  it('resolves a registered client and returns null for an unknown id', async () => {
    const reg = await registerClient(db, TENANT, { redirect_uris: ['https://claude.ai/cb'] }, Date.now())
    const found = await resolveClient(db, reg.client_id)
    expect(found?.clientId).toBe(reg.client_id)
    expect(found?.redirectUris).toEqual(['https://claude.ai/cb'])
    expect(await resolveClient(db, 'mcp_nonexistent')).toBeNull()
    expect(await resolveClient(db, '')).toBeNull()
  })
})
