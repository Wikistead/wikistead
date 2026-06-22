// Integration test — real Postgres + OpenFGA + a real test OpenID Provider.
// Phase 5e tenant OIDC settings: admin-gated; enabling validates discovery; the
// client secret is write-only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { getTenantOidc, updateTenantOidc, validateIssuer } from '../routes/tenant-oidc.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const STRANGER = 'oidc-stranger'
const REDIRECT = 'http://dev.localhost/auth/callback'
const BAD_ISSUER = 'http://127.0.0.1:1/' // connection refused → discovery fails fast
let db: TenantDb
let issuer: TestIssuer

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  issuer = await startTestIssuer({ clientId: 'wikistead-tenant' })
}, 30_000)
afterAll(async () => {
  await issuer.close()
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('tenant OIDC settings', () => {
  it('validateIssuer: a real discovery doc passes; an unreachable issuer fails', async () => {
    expect(await validateIssuer(issuer.url)).toBeNull()
    expect(await validateIssuer(BAD_ISSUER)).toBeTruthy()
  })

  it('a non-admin cannot update (403)', async () => {
    await expect(updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: STRANGER, issuer: issuer.url, clientId: 'c', redirectUri: REDIRECT, enabled: false,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('enabling validates discovery: a bad issuer is rejected (400), a real one succeeds', async () => {
    await expect(updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: BAD_ISSUER, clientId: 'c', redirectUri: REDIRECT, enabled: true,
    })).rejects.toMatchObject({ statusCode: 400, code: 'oidc_unreachable' })

    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant',
      clientSecret: 'top-secret', redirectUri: REDIRECT, enabled: true,
    })
    const v = await getTenantOidc(db)
    expect(v).toMatchObject({ issuer: issuer.url, clientId: 'wikistead-tenant', enabled: true, hasSecret: true })
    // The secret is never exposed by the read.
    expect(JSON.stringify(v)).not.toContain('top-secret')
  })

  it('the secret is write-only: a blank value keeps it, an explicit null clears it', async () => {
    // No secret supplied → keep the stored one.
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(true)
    // Explicit null → clear (public client).
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', clientSecret: null, redirectUri: REDIRECT, enabled: false,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(false)
  })
})
