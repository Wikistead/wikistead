// Password hashing for local members (#568 / ADR-198 §4).
//
// scrypt from node:crypto — no new dependency, and a memory-hard KDF is what a stolen credentials
// table should cost an attacker. The PARAMETERS ARE ENCODED IN THE STORED STRING, so raising them
// later is a per-credential upgrade on next login rather than a flag day:
//
//     s2$<N>$<r>$<p>$<saltBase64>$<hashBase64>
//
// Two node-specific facts this file exists to encode (both measured, ADR-198 §4):
//   - `128 * N * r` exceeds node's DEFAULT maxmem and throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS, so
//     maxmem is set explicitly — and DERIVED from the parameters rather than written as a literal,
//     because #986 raised N and a hard-coded 64 MiB would have started throwing on every hash.
//   - a verification costs real CPU on a libuv thread, and the pool defaults to FOUR. An
//     unauthenticated endpoint that burns one per request is a cheap exhaustion lever, so
//     verifications run under a small concurrency cap (ADR-198 §4 C4) and queue beyond it. The cap
//     is SHARED with the share-link password store (#986): the thread pool it protects is one pool,
//     and both of its users are reachable without authenticating.
//
// Never call these inside a transaction: the KDF would hold a database connection for its whole
// duration (the share-link password lesson).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

// OWASP's stated minimum for scrypt (Password Storage Cheat Sheet). Raise N here; existing hashes
// keep their own parameters and re-hash on their owner's next successful login (see needsRehash).
//
// ⚠️ #986: this said "OWASP's interactive floor" at N=2^15 and it was not — the floor is 2^17, four
// times higher, and nobody had re-checked the number against the source since it was written down.
// The pin that guards it asserts `>= 131072` by RUNNING the hash and reading the parameters back out
// of the stored string, so raising the floor again never needs a matching test edit.
export const SCRYPT_N = 131072
export const SCRYPT_R = 8
export const SCRYPT_P = 1
const KEYLEN = 64
const SALT_BYTES = 16

/**
 * scrypt allocates `128 * N * r` bytes; node refuses if that exceeds `maxmem`. Derived, never a
 * literal: at N=2^17, r=8 the requirement is exactly 128 MiB, and the 64 MiB constant this replaced
 * would have made every hash throw. The multiple gives the allocator headroom rather than sitting
 * exactly on the limit; the floor keeps small legacy parameters from lowering it.
 */
export const maxmemFor = (n: number, r: number): number => Math.max(64 * 1024 * 1024, 256 * n * r)

// ── concurrency cap (C4) ────────────────────────────────────────────────────
// A FIFO of waiters, not a semaphore library: the whole mechanism is "at most K KDFs in flight".
const MAX_CONCURRENT_KDF = 4
let inFlight = 0
const waiting: (() => void)[] = []
export async function withKdfSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_KDF) await new Promise<void>((resolve) => waiting.push(resolve))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    waiting.shift()?.()
  }
}

const enc = (b: Buffer) => b.toString('base64')

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await withKdfSlot(() => scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemFor(SCRYPT_N, SCRYPT_R) }))
  return `s2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${enc(salt)}$${enc(hash)}`
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; hash: Buffer }
export function parseHash(stored: string): Parsed | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 's2') return null
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(n), R = Number(r), P = Number(p)
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || N <= 0 || R <= 0 || P <= 0) return null
  // A stored record could name parameters this process refuses to run (a hash written by a future
  // version with a higher N, restored onto an older binary). Bound them rather than letting a row
  // decide how much memory to allocate.
  if (N > 1 << 20 || R > 32 || P > 16) return null
  try {
    return { N, r: R, p: P, salt: Buffer.from(saltB64, 'base64'), hash: Buffer.from(hashB64, 'base64') }
  } catch { return null }
}

// Verify `password` against a stored hash. A malformed record verifies to FALSE — never throws, so a
// corrupt row cannot turn a login into a 500 that distinguishes it from a wrong password.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored)
  if (!parsed) return false
  const { N, r, p, salt, hash } = parsed
  const maxmem = maxmemFor(N, r)
  let derived: Buffer
  try {
    derived = await withKdfSlot(() => scrypt(password, salt, hash.length, { N, r, p, maxmem }))
  } catch { return false }
  return derived.length === hash.length && timingSafeEqual(derived, hash)
}

// True when a valid password should be re-hashed at today's parameters (opportunistic upgrade on a
// successful login — the only moment the plaintext is in hand).
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored)
  if (!parsed) return true
  return parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P
}

// A fixed hash to verify against when the identifier is unknown (ADR-198 §3 C1). The refusal must
// cost what a real verification costs, or the response time answers "does this account exist?" — so
// the dummy is a REAL hash at today's parameters, computed once per process, and the caller runs a
// genuine verification against it rather than returning early.
let dummy: Promise<string> | null = null
export function dummyHash(): Promise<string> {
  // The value never authenticates anything: a random password nobody holds.
  dummy ??= hashPassword(randomBytes(32).toString('base64'))
  return dummy
}
