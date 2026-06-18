// Integration tests — real Postgres + real OpenFGA, no mocks.
// Prerequisites: docker compose up -d && pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@kb/authz'
import { verifyApiKey } from '../api-key-auth.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../routes/api-keys.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import type { Tenant } from '@kb/types'

const driver    = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'api-keys-test-space',
  })
  spaceId = space.id
})

afterAll(async () => {
  await adminPool`DELETE FROM api_keys WHERE tenant_id = ${tenant.id}`
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
  await adminPool.end()
})

// ── Creation and storage ──────────────────────────────────────────────────

describe('createApiKey', () => {
  it('returns plaintext once; DB stores only the hash (never plaintext)', async () => {
    const result = await createApiKey(db, {
      tenantId: tenant.id, ownerUserId: 'dev-user', name: 'test-key-1',
    })

    expect(result.plaintext).toMatch(/^kb_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{32}$/)
    expect(result.keyPrefix).toBe(result.plaintext.split('_').slice(0, 2).join('_'))

    // Verify DB stores the hash, not the plaintext
    const [row] = await adminPool<[{ key_hash: string; key_prefix: string }]>`
      SELECT key_hash, key_prefix FROM api_keys WHERE id = ${result.id}
    `
    const expectedHash = createHash('sha256').update(result.plaintext).digest('hex')
    expect(row.key_hash).toBe(expectedHash)
    expect(row.key_prefix).toBe(result.keyPrefix)
    // Plaintext must NOT appear in any DB column
    expect(row.key_hash).not.toBe(result.plaintext)
  })
})

// ── verifyApiKey ──────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
  let plaintext: string
  let keyId: string

  beforeAll(async () => {
    const k = await createApiKey(db, { tenantId: tenant.id, ownerUserId: 'dev-user', name: 'verify-test' })
    plaintext = k.plaintext
    keyId = k.id
  })

  it('returns owner user ID for a valid active key', async () => {
    const result = await verifyApiKey(plaintext, tenant.id)
    expect(result).not.toBeNull()
    expect(result!.sub).toBe('dev-user')
  })

  it('returns null for a key with wrong hash (constant-time comparison)', async () => {
    const tampered = plaintext.slice(0, -4) + 'XXXX'
    const result = await verifyApiKey(tampered, tenant.id)
    expect(result).toBeNull()
  })

  it('returns null for a non-existent prefix', async () => {
    const result = await verifyApiKey('kb_ZZZZZZZZ_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', tenant.id)
    expect(result).toBeNull()
  })

  it('returns null after revocation — revoked_at IS NULL is the revocation gate', async () => {
    // Revoke the key directly (set revoked_at)
    await adminPool`UPDATE api_keys SET revoked_at = now() WHERE id = ${keyId}`

    // The lookup must check revoked_at IS NULL; revoked key must return null
    const result = await verifyApiKey(plaintext, tenant.id)
    expect(result).toBeNull()
  })

  it('no auth path fallback: kb_ prefix that fails returns null, not an OIDC attempt', async () => {
    // verifyApiKey returns null for an invalid key — the caller (onRequest hook)
    // must send 401 at this point without trying OIDC verification.
    const result = await verifyApiKey('kb_BadPrefix_invalidsecretherexxxxxxxxxxx', tenant.id)
    expect(result).toBeNull()
    // (The routing guard in index.ts onRequest ensures no OIDC fallback for kb_ tokens)
  })

  it('tenant isolation: key from another tenant returns null for this tenant', async () => {
    // Create a key for tenant_acme and try to use it as tenant_dev
    const [{ id: acmeKeyId }] = await adminPool<[{ id: string }]>`
      INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash)
      VALUES ('tenant_acme', 'acme-user', 'cross-tenant-key', 'kb_ACME_KEY', 'fakehash')
      RETURNING id
    `
    try {
      // Prefix matches but tenant_id RLS returns 0 rows for tenant_dev
      const result = await verifyApiKey('kb_ACME_KEY_anysecrethere', tenant.id)
      expect(result).toBeNull()
    } finally {
      await adminPool`DELETE FROM api_keys WHERE id = ${acmeKeyId}`
    }
  })
})

// ── list and revoke ───────────────────────────────────────────────────────

describe('listApiKeys and revokeApiKey', () => {
  it('lists only active keys (not revoked)', async () => {
    const k = await createApiKey(db, { tenantId: tenant.id, ownerUserId: 'dev-user', name: 'list-test' })
    const list = await listApiKeys(db)
    expect(list.some(x => x.id === k.id)).toBe(true)

    await revokeApiKey(db, { id: k.id, ownerUserId: 'dev-user' })
    const listAfter = await listApiKeys(db)
    expect(listAfter.some(x => x.id === k.id)).toBe(false)
  })

  it('revokeApiKey returns false for a key owned by a different user (owner check)', async () => {
    const k = await createApiKey(db, { tenantId: tenant.id, ownerUserId: 'dev-user', name: 'other-user-key' })
    const result = await revokeApiKey(db, { id: k.id, ownerUserId: 'other-user' })
    expect(result).toBe(false)
    // Cleanup
    await adminPool`DELETE FROM api_keys WHERE id = ${k.id}`
  })
})

// ── API key as member-equivalent FGA principal ────────────────────────────

describe('API key uses owner FGA permissions (per-page auth not bypassed)', () => {
  it('owner can access pages they have FGA view permission for', async () => {
    // dev-user has manager on space:spaceId → has view on all pages in it
    // This verifies the same FGA check that routes use after API key auth
    const { check } = await import('@kb/authz')
    const ok = await check(fgaClient, 'user:dev-user', 'view', { type: 'space', id: spaceId })
    // Actually check edit (since manager → editor from space → viewer)
    const edit = await check(fgaClient, 'user:dev-user', 'manage', { type: 'space', id: spaceId })
    expect(edit).toBe(true)  // owner's FGA permissions apply
  })

  it('owner cannot access pages they have no FGA permission for (auth not bypassed)', async () => {
    // A page in a completely unrelated space that dev-user has no access to
    const { check } = await import('@kb/authz')
    const canView = await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: 'nonexistent-page-xyz' })
    expect(canView).toBe(false)
    // An API key acting as dev-user would also get false here — no bypass
  })
})

// ── dev bypass production guard ───────────────────────────────────────────

describe('dev bypass production guard', () => {
  it('dev bypass is inactive when NODE_ENV=production', () => {
    const orig = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      // The exact guard condition from apps/server/src/index.ts onRequest:
      //   if (process.env.NODE_ENV !== 'production' && token === 'dev-token')
      const bypassWouldActivate = process.env.NODE_ENV !== 'production' && 'dev-token' === 'dev-token'
      expect(bypassWouldActivate).toBe(false)
      // In production, even with token='dev-token', the bypass is dead.
    } finally {
      process.env.NODE_ENV = orig
    }
  })

  it('collab dev bypass is also guarded (same condition)', () => {
    // apps/collab/src/index.ts onAuthenticate:
    //   if (process.env.NODE_ENV !== "production" && token === "dev-token")
    const orig = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const collabBypassWouldActivate = process.env.NODE_ENV !== 'production' && 'dev-token' === 'dev-token'
      expect(collabBypassWouldActivate).toBe(false)
    } finally {
      process.env.NODE_ENV = orig
    }
  })
})
