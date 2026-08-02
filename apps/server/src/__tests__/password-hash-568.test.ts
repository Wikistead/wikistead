// #568 / ADR-198 §4: the password KDF. What is on trial here is not "does scrypt work" but the four
// decisions around it that a wrong answer makes exploitable:
//
//   - the parameters live IN the stored string, so they can be raised without a flag day;
//   - node's DEFAULT maxmem refuses the parameters we chose, so they must be passed explicitly (this
//     is the failure that would otherwise appear as a 500 on every login);
//   - a malformed or hostile record verifies to FALSE rather than throwing (a corrupt row must not be
//     distinguishable from a wrong password) — and must not let the row choose how much memory to
//     allocate;
//   - the unknown-identifier path has a REAL hash to verify against, or response time answers
//     "does this account exist?".
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, needsRehash, parseHash, dummyHash, SCRYPT_N, SCRYPT_R, SCRYPT_P } from '../auth/password-hash.js'

describe('#568 §4: scrypt with explicit parameters', () => {
  it('hashes and verifies, and a wrong password does not', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  }, 30_000)

  it('the parameters ride IN the record, so a stored hash is self-describing', async () => {
    const stored = await hashPassword('pw')
    expect(stored.startsWith(`s2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`)).toBe(true)
    const parsed = parseHash(stored)!
    expect(parsed.N).toBe(SCRYPT_N)
    expect(parsed.salt.length).toBe(16)
    expect(parsed.hash.length).toBe(64)
  }, 30_000)

  it('two hashes of the same password differ (the salt is per-credential)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  }, 30_000)

  it('a hash at OLDER parameters still verifies, and asks to be upgraded', async () => {
    // The point of encoding parameters: a record written before a raise keeps working. Verified with
    // a genuinely cheaper record (N=1024), which is what a pre-raise row would look like.
    const cheap = `s2$1024$8$1$${Buffer.alloc(16, 7).toString('base64')}$`
    // build it for real so this is not a hand-written string that only the parser believes
    const { scrypt } = await import('node:crypto')
    const derived: Buffer = await new Promise((res, rej) =>
      scrypt('legacy', Buffer.alloc(16, 7), 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))))
    const stored = cheap + derived.toString('base64')
    expect(await verifyPassword('legacy', stored)).toBe(true)
    expect(needsRehash(stored), 'an old-parameter record wants re-hashing').toBe(true)
    expect(needsRehash(await hashPassword('fresh')), 'a current one does not').toBe(false)
  }, 30_000)

  it("node's DEFAULT maxmem refuses these parameters — which is why they are passed explicitly", async () => {
    // Measured, not assumed: 128·N·r at N=2^15, r=8 is exactly 32 MiB and node's default maxmem is
    // 32 MiB, so scrypt throws SYNCHRONOUSLY (ERR_CRYPTO_INVALID_SCRYPT_PARAMS) before the callback.
    // Dropping the explicit maxmem would therefore break every login, not slow it down — this pin
    // keeps the reason attached to the code that depends on it.
    const { scrypt } = await import('node:crypto')
    expect(() => scrypt('p', Buffer.alloc(16), 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, () => {}))
      .toThrow(/Invalid scrypt params/)
    // ...and with ours it succeeds
    expect(await verifyPassword('x', await hashPassword('x'))).toBe(true)
  }, 30_000)

  it('a malformed record verifies FALSE and never throws', async () => {
    for (const bad of ['', 'not-a-hash', 's2$', 's2$a$b$c$d$e', 's1$32768$8$1$AAAA$BBBB', 's2$32768$8$1$AAAA']) {
      expect(await verifyPassword('pw', bad), bad).toBe(false)
      expect(needsRehash(bad), bad).toBe(true)
    }
  }, 30_000)

  it('a record cannot ask this process for unbounded memory', () => {
    // A row is data, and data must not choose an allocation. N=2^30 at r=32 would be terabytes.
    expect(parseHash(`s2$1073741824$32$1$AAAA$BBBB`)).toBeNull()
    expect(parseHash(`s2$32768$1024$1$AAAA$BBBB`)).toBeNull()
    expect(parseHash(`s2$-1$8$1$AAAA$BBBB`)).toBeNull()
  })

  it('the dummy hash is a REAL verifiable record, so an unknown identifier costs a real KDF', async () => {
    const d = await dummyHash()
    expect(parseHash(d), 'it is a genuine record, not a placeholder string').not.toBeNull()
    expect(needsRehash(d), 'at current parameters').toBe(false)
    expect(await verifyPassword('anything', d), 'and nothing authenticates against it').toBe(false)
    expect(await dummyHash(), 'computed once per process').toBe(d)
  }, 30_000)

  it('the unknown-identifier refusal costs the same order as a real one (no existence oracle by timing)', async () => {
    // Not a strict bound — a shared CI box cannot promise microseconds — but a REGRESSION here would
    // be an early return, which is orders of magnitude, not percent. Measured against 5x.
    const stored = await hashPassword('real-password')
    const t0 = performance.now()
    await verifyPassword('wrong-password', stored)
    const real = performance.now() - t0
    const d = await dummyHash()
    const t1 = performance.now()
    await verifyPassword('wrong-password', d)
    const unknown = performance.now() - t1
    expect(unknown, `unknown ${unknown.toFixed(1)}ms vs real ${real.toFixed(1)}ms`).toBeGreaterThan(real / 5)
  }, 30_000)

  it('concurrent verifications all resolve (the cap queues, it does not drop)', async () => {
    const stored = await hashPassword('concurrent')
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      verifyPassword(i % 2 === 0 ? 'concurrent' : 'nope', stored)))
    expect(results.filter(Boolean).length).toBe(6)
  }, 60_000)
})
