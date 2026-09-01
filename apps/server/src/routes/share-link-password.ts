import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { SCRYPT_N, SCRYPT_R, SCRYPT_P, maxmemFor, withKdfSlot } from '../auth/password-hash.js'

// #233 / ADR-107: share-link password hashing. A share-link password is LOW-ENTROPY (a human types it),
// so — unlike the high-entropy tokens hashed with sha256 elsewhere (api-key-auth / invites / scim tokens)
// — it needs a memory-hard KDF: node:crypto `scrypt` with a per-link random salt. No new dependency
// (built-in), ADR-011-clean. Plaintext is never stored or logged; comparison is constant-time.
//
// ⚠️ #986 / ADR-107 correction: this file used to call `scrypt(password, salt, KEYLEN)` with NO
// options, so every hash ran at node's own default (N=2^14) — four powers of two below OWASP's stated
// floor — and stored two fields where §2 had decided on `scrypt$N$r$p$salt$hash`. The parameters now
// come from ONE place (`auth/password-hash.ts`), so the two credential stores in this codebase cannot
// state different numbers, and the concurrency cap is the same one: raising N raised what a single
// verification costs, and the share-link door is reachable without authenticating.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>
const KEYLEN = 32
const SALT_LEN = 16
// Serialised form: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — self-describing, so raising the
// parameters again does not invalidate every password-protected link issued under the old ones.
const PREFIX = 'scrypt'

// The parameters the two-field form could only have been written with: node's `scrypt` defaults.
// Rows in that shape predate #986 and MUST keep verifying — silently locking out every currently
// protected link is not a security improvement, it is an outage. They upgrade in place instead
// (`needsSharePasswordRehash`, called on the one occasion the plaintext is in hand).
const LEGACY = { N: 16384, r: 8, p: 1 }

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const derived = await withKdfSlot(() =>
    scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemFor(SCRYPT_N, SCRYPT_R) }))
  return `${PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

interface ParsedShareHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer; legacy: boolean }

/**
 * Both shapes, or null. Null for anything malformed — the caller turns that into a plain `false`, so
 * a corrupt row is indistinguishable from a wrong password rather than becoming a 500.
 */
export function parseSharePassword(stored: string): ParsedShareHash | null {
  const parts = stored.split('$')
  if (parts[0] !== PREFIX) return null
  let N: number, r: number, p: number, saltHex: string, hashHex: string, legacy: boolean
  if (parts.length === 6) {
    ;[, , , , saltHex, hashHex] = parts as [string, string, string, string, string, string]
    N = Number(parts[1]); r = Number(parts[2]); p = Number(parts[3]); legacy = false
  } else if (parts.length === 3) {
    ;[, saltHex, hashHex] = parts as [string, string, string]
    N = LEGACY.N; r = LEGACY.r; p = LEGACY.p; legacy = true
  } else return null
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) return null
  // A stored record must not decide how much memory this process allocates (the same bound
  // `password-hash.ts` applies, for the same reason).
  if (N > 1 << 20 || r > 32 || p > 16) return null
  const salt = Buffer.from(saltHex, 'hex')
  const hash = Buffer.from(hashHex, 'hex')
  if (salt.length !== SALT_LEN || hash.length !== KEYLEN) return null
  return { N, r, p, salt, hash, legacy }
}

// Constant-time verify. Returns false for any malformed stored value (never throws). Wrong password is
// indistinguishable from a malformed hash — both false, no oracle.
export async function verifySharePassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const parsed = parseSharePassword(stored)
  if (!parsed) return false
  const { N, r, p, salt, hash } = parsed
  let derived: Buffer
  try {
    derived = await withKdfSlot(() => scrypt(password, salt, hash.length, { N, r, p, maxmem: maxmemFor(N, r) }))
  } catch { return false }
  return derived.length === hash.length && timingSafeEqual(derived, hash)
}

/**
 * True when a stored value that just verified should be written again at today's parameters — the
 * opportunistic upgrade `password-hash.ts` already does for member passwords (ADR-198 §4). ADR-107
 * argued the value was small here because a share-link password is issuance-time-only; the #986
 * ruling took the other side, on the ground that two credential stores with different habits leave
 * the next reader unable to tell which one is right.
 */
export function needsSharePasswordRehash(stored: string): boolean {
  const parsed = parseSharePassword(stored)
  if (!parsed) return false // unreadable: there is nothing to upgrade, and it never verifies anyway
  return parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P
}
