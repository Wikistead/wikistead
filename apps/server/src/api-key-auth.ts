// API key verification. Third authentication principal after member (OIDC) and guest.
//
// Security invariants maintained here:
//   1. revoked_at IS NULL MUST appear in every DB lookup — soft-delete rows must
//      never authenticate. The partial index on api_keys enforces this efficiently.
//      #628 / ADR-215: an EXPIRED key is refused in the same clause, deliberately. A second gate
//      somewhere else could drift out of step with this one, and the two answer the same question —
//      "may this credential still speak" — so they are one condition, not two.
//   2. Constant-time comparison (timingSafeEqual) prevents timing oracle attacks.
//   3. Last-used update is fire-and-forget so the hot path is never blocked.
import { createHash, timingSafeEqual } from 'node:crypto'
import { withTenantTx } from './db/index.js' // #382

interface ApiKeyRow { id: string; owner_user_id: string; key_hash: string; scope: string | null; expires_at: Date | null; capabilities: string[] | null; space_ids: string[] | null; permission_model: number | null; permissions: Record<string, string> | string | null; deactivated_at: Date | null }

// #476 / ADR-178: the two ways a valid key can be answered. `deactivated` is the owner being frozen —
// a state the tenant can undo by upgrading — so the caller says so rather than returning the generic
// "invalid key" that would send a paying customer hunting for a credential problem they do not have.
export type ApiKeyPrincipal = {
  sub: string; scope: 'read' | 'write'; keyId: string; deactivated: false
  // #628 / ADR-215 §2: the capabilities a NARROWED key carries, or undefined for an un-narrowed one.
  // Undefined and empty are different states: undefined is "this key was never narrowed", empty is
  // "narrowed to nothing", and reading them the same way would open every route to the second.
  capabilities?: readonly string[]
  // #637 / ADR-216 §4: the spaces a key is confined to, when it is confined that way. Same three states
  // as above and for the same reason — undefined is "not confined by space", empty is "confined to no
  // space at all". The carrier is here BEFORE the dimension exists, deliberately: `isNarrowedKey` is
  // what decides whether the credential-minting refusal and the route table apply, and shipping the
  // column first would mean a window in which a space-confined key counted as unconfined. The lookup
  // that fills this is the next slice (the column is EE-owned data, ADR-216 §7 / sub-task 5).
  spaces?: ReadonlySet<string>
  // #667 / ADR-221 §3: which rule reads this key, and the resource-type matrix when it carries one.
  //
  // `permissions` is SELECTed and set HERE and not only in the gate, which is the whole point of the
  // field existing on the principal: `isNarrowedKey` can only see what the row-reader put here, so
  // adding the column and teaching the gate about it while leaving this SELECT alone would reinstate
  // exactly the fail-open it was widened to close — one layer lower, and invisible to every unit test
  // that builds a principal by hand.
  permissionModel: 1 | 2
  permissions?: Readonly<Record<string, string>>
}
export type ApiKeyDeactivated = { deactivated: true }
// #628 / ADR-215 §5: an EXPIRED key answers the caller exactly as an unknown one does — the same 401,
// because telling somebody "that key existed and ran out" is telling them a key existed. What differs is
// the LOG line. "The key stopped working" is the question somebody brings to the audit log, and a
// refusal that leaves no trace sends them to rotate a credential that was fine.
// `deactivated: false` rides along so existing readers (#476's pin reads `result?.deactivated`) keep
// working: an expired key is not a frozen owner, and saying so costs one field.
export type ApiKeyExpired = { expired: true; deactivated: false }
export type ApiKeyResult = ApiKeyPrincipal | ApiKeyDeactivated | ApiKeyExpired

/** `jsonb` arrives as text from this driver; an unparseable value confines to nothing rather than to everything. */
function parsePermissions(raw: Record<string, string> | string): Readonly<Record<string, string>> {
  if (typeof raw !== 'string') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch { return {} }
}

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
      SELECT k.id, k.owner_user_id, k.key_hash, k.scope, k.expires_at, k.capabilities, k.space_ids,
             k.permission_model, k.permissions, m.deactivated_at
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

  // #628: expiry is decided HERE, after the comparison, for the same reason the deactivation branch
  // below is: answering it earlier would tell somebody who does NOT hold the secret whether a key with
  // this 12-character prefix has expired. The row was still fetched by the revocation clause, so a
  // revoked key never reaches this line — the two remain one gate in effect, read one after the other.
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return { expired: true, deactivated: false }

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
  return {
    sub: row.owner_user_id, scope: row.scope === 'read' ? 'read' : 'write', keyId: row.id, deactivated: false,
    // #667: default 1 rather than trusting the column to be there. A row written before migration 121,
    // or read by a build that predates it, is a v1 key — the reading that changes nothing.
    permissionModel: row.permission_model === 2 ? 2 : 1,
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    ...(row.space_ids ? { spaces: new Set(row.space_ids) } : {}),
    // …parsed here, because this driver hands `jsonb` back as TEXT. Measured: the column came out as
    // '{"pages":"read"}' and every reader downstream would have asked a string for its keys and got
    // none — a matrix that confines to nothing, which fails CLOSED but silently and wrongly.
    ...(row.permissions ? { permissions: parsePermissions(row.permissions) } : {}),
  }
}
