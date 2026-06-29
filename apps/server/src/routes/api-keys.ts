import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import type { TenantDb } from '../db/index.js'

export type ApiScope = 'read' | 'write'

interface ApiKeyRow {
  id: string; tenant_id: string; owner_user_id: string; name: string
  key_prefix: string; scope: string | null; created_at: Date; last_used_at: Date | null; revoked_at: Date | null
}
export interface ApiKeySummary {
  id: string; name: string; keyPrefix: string; scope: ApiScope; createdAt: Date; lastUsedAt: Date | null
}

// The tenant policy cap on what scope keys may be issued with (admin-set). NULL =
// 'write' (no cap). A key's scope may never EXCEED this.
export async function getApiKeyMaxScope(db: TenantDb): Promise<ApiScope> {
  const [row] = await db.sql<{ api_key_max_scope: string | null }[]>`
    SELECT api_key_max_scope FROM tenant_settings LIMIT 1
  `
  return row?.api_key_max_scope === 'read' ? 'read' : 'write'
}

export async function setApiKeyMaxScope(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; maxScope: ApiScope },
): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${args.userId}`, relation: 'admin', object: `tenant:${args.tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
  if (args.maxScope !== 'read' && args.maxScope !== 'write') throw Object.assign(new Error('invalid scope'), { statusCode: 400 })
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, api_key_max_scope, updated_at)
    VALUES (${args.tenantId}, ${args.maxScope}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET api_key_max_scope = ${args.maxScope}, updated_at = now()
  `
}
export interface ApiKeyCreated extends ApiKeySummary {
  // Plaintext is returned ONCE at creation and never stored.
  plaintext: string
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a new API key. Returns plaintext once — caller must display it immediately
// and never request it again; only the hash is persisted.
//
// Key format: wks_{8-char prefix}_{32-char secret}  (45 chars)
// key_prefix: used for O(1) DB lookup before hash comparison.
// key_hash:   sha256(plaintext) hex — plaintext is discarded after this call.
//
// scope (Phase 5f) restricts the key below the owner's authority; it is capped by
// the tenant policy (getApiKeyMaxScope) — requesting 'write' when the cap is 'read'
// is rejected (403). Defaults to 'write' (the owner's full authority, = pre-5f).
// #126 / ADR-063: API key creation is entitlement-gated (resolveEntitlements(plan).apiAccess).
// The gate reads the resolved boolean — no plan checks scattered (entitlement⟂authz separation).
// Which plans get apiAccess is a business placeholder; self-host (UNLIMITED) is always on.
export async function createApiKey(
  db: TenantDb,
  args: { tenantId: string; plan: string; ownerUserId: string; name: string; scope?: ApiScope },
): Promise<ApiKeyCreated> {
  if (!resolveEntitlements(args.plan).apiAccess) {
    throw entitlementDenied('api', 'API keys are not available on this plan') // 403 api_not_entitled + upgrade
  }
  const scope: ApiScope = args.scope === 'read' ? 'read' : 'write'
  // Cap: a key may never exceed the tenant policy (deny write when capped to read).
  if (scope === 'write' && (await getApiKeyMaxScope(db)) === 'read') {
    throw Object.assign(new Error('this tenant allows read-only API keys only'), { statusCode: 403, code: 'scope_capped' })
  }
  const prefix    = randomBytes(6).toString('base64url')   // exactly 8 chars (6 bytes → base64url)
  const secret    = randomBytes(24).toString('base64url')  // exactly 32 chars (24 bytes → base64url)
  const plaintext = `wks_${prefix}_${secret}`
  const keyPrefix = `wks_${prefix}`
  const keyHash   = createHash('sha256').update(plaintext).digest('hex')

  const [row] = await db.sql<ApiKeyRow[]>`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope)
    VALUES (${args.tenantId}, ${args.ownerUserId}, ${args.name}, ${keyPrefix}, ${keyHash}, ${scope})
    RETURNING id, tenant_id, owner_user_id, name, key_prefix, scope, created_at, last_used_at, revoked_at
  `
  const result: ApiKeyCreated = { id: row.id, name: row.name, keyPrefix: row.key_prefix, scope, createdAt: row.created_at, lastUsedAt: null, plaintext }
  emit({ type: 'api_key.created', tenantId: args.tenantId, keyId: row.id, actorId: args.ownerUserId })
  return result
}

// List active API keys for the current tenant (RLS scopes automatically).
// key_hash is never exposed.
export async function listApiKeys(db: TenantDb): Promise<ApiKeySummary[]> {
  const rows = await db.sql<ApiKeyRow[]>`
    SELECT id, name, key_prefix, scope, created_at, last_used_at
    FROM api_keys
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `
  return rows.map(r => ({
    id: r.id, name: r.name, keyPrefix: r.key_prefix,
    scope: r.scope === 'read' ? 'read' : 'write',
    createdAt: r.created_at, lastUsedAt: r.last_used_at,
  }))
}

// Revoke a key. Only the key's owner can revoke (owner_user_id = caller's user ID).
// Returns true if revoked, false if not found / already revoked / not owned by caller.
export async function revokeApiKey(
  db: TenantDb,
  args: { id: string; ownerUserId: string },
): Promise<boolean> {
  const result = await db.sql`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE id              = ${args.id}
      AND owner_user_id   = ${args.ownerUserId}
      AND revoked_at IS NULL
  `
  if (result.count > 0) {
    // Derive tenantId from db context (RLS ensures this is the correct tenant)
    const [row] = await db.sql<[{ tenant_id: string }]>`SELECT tenant_id FROM api_keys WHERE id = ${args.id}`
    if (row) emit({ type: 'api_key.revoked', tenantId: row.tenant_id, keyId: args.id, actorId: args.ownerUserId })
  }
  return result.count > 0
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function apiKeysPlugin(app: FastifyInstance) {
  app.post<{ Body: { name: string; scope?: ApiScope } }>('/api-keys', async (req, reply) => {
    const created = await createApiKey(req.db, {
      tenantId: req.tenant.id,
      plan: req.tenant.plan,
      ownerUserId: req.user.sub,
      name: req.body.name,
      scope: req.body?.scope,
    })
    return reply.code(201).send(created)
  })

  app.get('/api-keys', async (req) => listApiKeys(req.db))

  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
    const revoked = await revokeApiKey(req.db, { id: req.params.id, ownerUserId: req.user.sub })
    if (!revoked) return reply.code(404).send({ error: 'not found or not owned by caller' })
    return reply.code(204).send()
  })

  // Tenant API policy: the max scope keys may be issued with (tenant#admin).
  app.get('/admin/api-policy', async (req) => ({ maxScope: await getApiKeyMaxScope(req.db) }))

  app.patch<{ Body: { maxScope: ApiScope } }>('/admin/api-policy', async (req, reply) => {
    await setApiKeyMaxScope(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub, maxScope: req.body?.maxScope })
    return reply.code(204).send()
  })
}
