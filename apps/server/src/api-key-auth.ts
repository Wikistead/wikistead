// API key verification. Third authentication principal after member (OIDC) and guest.
//
// Security invariants maintained here:
//   1. revoked_at IS NULL MUST appear in every DB lookup — soft-delete rows must
//      never authenticate. The partial index on api_keys enforces this efficiently.
//   2. Constant-time comparison (timingSafeEqual) prevents timing oracle attacks.
//   3. Last-used update is fire-and-forget so the hot path is never blocked.
import { createHash, timingSafeEqual } from 'node:crypto'
import { withTenantTx } from './db/index.js' // #382

interface ApiKeyRow { id: string; owner_user_id: string; key_hash: string; scope: string | null; deactivated_at: Date | null }

// #476 / ADR-178: the two ways a valid key can be answered. `deactivated` is the owner being frozen —
// a state the tenant can undo by upgrading — so the caller says so rather than returning the generic
// "invalid key" that would send a paying customer hunting for a credential problem they do not have.
export type ApiKeyPrincipal = { sub: string; scope: 'read' | 'write'; keyId: string; deactivated: false }
export type ApiKeyDeactivated = { deactivated: true }
export type ApiKeyResult = ApiKeyPrincipal | ApiKeyDeactivated

// Verify an API key and return the owner's user ID + scope, or null if invalid/
// revoked. Called from onRequest ONLY when token starts with 'wks_' — no OIDC
// fallback. Key format: wks_{8-char prefix}_{32-char secret}.
// scope NULL is treated as 'write' (backward compatible with pre-5f keys).
export async function verifyApiKey(
  token: string,
  tenantId: string,
): Promise<ApiKeyResult | null> {
  if (!token.startsWith('wks_')) return null

  // keyPrefix is always 'wks_' (4 chars) + 8 base64url chars = 12 chars total.
  // base64url includes '_', so indexOf('_') is unreliable — use fixed-length slice.
  const keyPrefix = token.slice(0, 12)
  if (token.length < 13 || token[12] !== '_') return null

  // DB lookup. revoked_at IS NULL is mandatory — this is the revocation gate.
  // RLS (app.tenant_id) provides tenant isolation: wrong-tenant keys return 0 rows.
  // #476 / ADR-178: the owner's deactivation rides along on a LEFT JOIN — one round trip, and RLS
  // scopes `members` exactly as it scopes `api_keys`. LEFT, and read below rather than filtered here:
  // dropping the row would make this function return null, which the caller answers as a generic 401,
  // and the deactivation would be indistinguishable from an unknown key.
  const row = await (withTenantTx(tenantId, async (tx) => {
    const [r] = await tx<ApiKeyRow[]>`
      SELECT k.id, k.owner_user_id, k.key_hash, k.scope, m.deactivated_at
      FROM api_keys k
      LEFT JOIN members m ON m.sub = k.owner_user_id
      WHERE k.key_prefix    = ${keyPrefix}
        AND k.revoked_at IS NULL
    `
    return r ?? null
  }) as Promise<ApiKeyRow | null>)

  if (!row) return null

  // Constant-time comparison — prevents timing oracle even if prefix matched.
  const incoming = createHash('sha256').update(token).digest()
  const stored   = Buffer.from(row.key_hash, 'hex')
  if (incoming.length !== stored.length || !timingSafeEqual(incoming, stored)) return null

  // #476 / ADR-178: the deactivation branch runs HERE, after the comparison — never before it.
  // Deciding earlier would answer "is the owner of this 12-character prefix deactivated?" to someone
  // who does not hold the secret, which is invariant 2 at the top of this file. A member frozen by a
  // seat-cap downgrade keeps their FGA membership (that is what makes the freeze reversible), so this
  // is the only place that notices; the login path has its own check. The key itself is untouched —
  // ADR-064 promises a downgrade destroys nothing, so re-upgrading revives this same key.
  if (row.deactivated_at) return { deactivated: true }

  // Non-blocking last_used_at update — must not slow the auth hot path.
  // #428: through the TENANT driver, not the bare pool — api_keys is FORCE-RLS'd on app.tenant_id,
  // so a context-less UPDATE matched 0 rows and last_used_at never moved (audit-only impact; the
  // verification itself always ran inside withTenantTx above).
  void withTenantTx(tenantId, (tx) => tx`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`).catch(() => {})

  // keyId enables per-key rate limiting (#175) without re-querying on the hot path.
  return { sub: row.owner_user_id, scope: row.scope === 'read' ? 'read' : 'write', keyId: row.id, deactivated: false }
}
