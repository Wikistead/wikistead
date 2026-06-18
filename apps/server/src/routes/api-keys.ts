import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TenantDb } from '../db/index.js'

interface ApiKeyRow {
  id: string; tenant_id: string; owner_user_id: string; name: string
  key_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null
}
export interface ApiKeySummary {
  id: string; name: string; keyPrefix: string; createdAt: Date; lastUsedAt: Date | null
}
export interface ApiKeyCreated extends ApiKeySummary {
  // Plaintext is returned ONCE at creation and never stored.
  plaintext: string
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a new API key. Returns plaintext once — caller must display it immediately
// and never request it again; only the hash is persisted.
//
// Key format: kb_{8-char prefix}_{32-char secret}  (44 chars)
// key_prefix: used for O(1) DB lookup before hash comparison.
// key_hash:   sha256(plaintext) hex — plaintext is discarded after this call.
//
// TODO(phase: api): add scope ('read' | 'write') column for per-key permission scoping.
// TODO(phase: billing): gate API key creation by entitlement (resolveEntitlements(plan).apiAccess).
export async function createApiKey(
  db: TenantDb,
  args: { tenantId: string; ownerUserId: string; name: string },
): Promise<ApiKeyCreated> {
  const prefix    = randomBytes(6).toString('base64url')   // exactly 8 chars (6 bytes → base64url)
  const secret    = randomBytes(24).toString('base64url')  // exactly 32 chars (24 bytes → base64url)
  const plaintext = `kb_${prefix}_${secret}`
  const keyPrefix = `kb_${prefix}`
  const keyHash   = createHash('sha256').update(plaintext).digest('hex')

  const [row] = await db.sql<ApiKeyRow[]>`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash)
    VALUES (${args.tenantId}, ${args.ownerUserId}, ${args.name}, ${keyPrefix}, ${keyHash})
    RETURNING id, tenant_id, owner_user_id, name, key_prefix, created_at, last_used_at, revoked_at
  `
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: null,
    plaintext,
  }
}

// List active API keys for the current tenant (RLS scopes automatically).
// key_hash is never exposed.
export async function listApiKeys(db: TenantDb): Promise<ApiKeySummary[]> {
  const rows = await db.sql<ApiKeyRow[]>`
    SELECT id, name, key_prefix, created_at, last_used_at
    FROM api_keys
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `
  return rows.map(r => ({
    id: r.id, name: r.name, keyPrefix: r.key_prefix,
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
  return result.count > 0
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function apiKeysPlugin(app: FastifyInstance) {
  app.post<{ Body: { name: string } }>('/api-keys', async (req, reply) => {
    const created = await createApiKey(req.db, {
      tenantId: req.tenant.id,
      ownerUserId: req.user.sub,
      name: req.body.name,
    })
    return reply.code(201).send(created)
  })

  app.get('/api-keys', async (req) => listApiKeys(req.db))

  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
    const revoked = await revokeApiKey(req.db, { id: req.params.id, ownerUserId: req.user.sub })
    if (!revoked) return reply.code(404).send({ error: 'not found or not owned by caller' })
    return reply.code(204).send()
  })
}
