import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// #233 / ADR-107: share-link password hashing. A share-link password is LOW-ENTROPY (a human types it),
// so — unlike the high-entropy tokens hashed with sha256 elsewhere (api-key-auth / invites / scim tokens)
// — it needs a memory-hard KDF: node:crypto `scrypt` with a per-link random salt. No new dependency
// (built-in), ADR-011-clean. Plaintext is never stored or logged; comparison is constant-time.
const scrypt = promisify(scryptCb)
const KEYLEN = 32
const SALT_LEN = 16
// Serialised form: `scrypt$<saltHex>$<hashHex>` — self-describing so a future KDF change can be detected.
const PREFIX = 'scrypt'

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`
}

// Constant-time verify. Returns false for any malformed stored value (never throws). Wrong password is
// indistinguishable from a malformed hash — both false, no oracle.
export async function verifySharePassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== PREFIX) return false
  const salt = Buffer.from(parts[1]!, 'hex')
  const expected = Buffer.from(parts[2]!, 'hex')
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
