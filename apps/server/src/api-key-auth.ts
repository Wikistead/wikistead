// API key verification. Third authentication principal after member (OIDC) and guest.
//
// Security invariants maintained here:
//   1. revoked_at IS NULL MUST appear in every DB lookup — soft-delete rows must
//      never authenticate. The partial index on api_keys enforces this efficiently.
//   2. Constant-time comparison (timingSafeEqual) prevents timing oracle attacks.
//   3. Last-used update is fire-and-forget so the hot path is never blocked.
import { createHash, timingSafeEqual } from 'node:crypto'
import { pool } from './db/pool.js'

interface ApiKeyRow { id: string; owner_user_id: string; key_hash: string }

// Verify an API key and return the owner's user ID, or null if invalid/revoked.
// Called from onRequest ONLY when token starts with 'wks_' — no OIDC fallback.
// Key format: wks_{8-char prefix}_{32-char secret}
export async function verifyApiKey(
  token: string,
  tenantId: string,
): Promise<{ sub: string } | null> {
  if (!token.startsWith('wks_')) return null

  // keyPrefix is always 'wks_' (4 chars) + 8 base64url chars = 12 chars total.
  // base64url includes '_', so indexOf('_') is unreliable — use fixed-length slice.
  const keyPrefix = token.slice(0, 12)
  if (token.length < 13 || token[12] !== '_') return null

  // DB lookup. revoked_at IS NULL is mandatory — this is the revocation gate.
  // RLS (app.tenant_id) provides tenant isolation: wrong-tenant keys return 0 rows.
  const row = await (pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const [r] = await tx<ApiKeyRow[]>`
      SELECT id, owner_user_id, key_hash
      FROM api_keys
      WHERE key_prefix    = ${keyPrefix}
        AND revoked_at IS NULL
    `
    return r ?? null
  }) as Promise<ApiKeyRow | null>)

  if (!row) return null

  // Constant-time comparison — prevents timing oracle even if prefix matched.
  const incoming = createHash('sha256').update(token).digest()
  const stored   = Buffer.from(row.key_hash, 'hex')
  if (incoming.length !== stored.length || !timingSafeEqual(incoming, stored)) return null

  // Non-blocking last_used_at update — must not slow the auth hot path.
  void pool`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`

  return { sub: row.owner_user_id }
}
