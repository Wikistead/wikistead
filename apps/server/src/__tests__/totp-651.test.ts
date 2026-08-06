// #651 / ADR-219 §9: the TOTP verifier this product writes instead of importing.
//
// Checked against RFC 6238's published test vectors, not against expectations computed here. A test that
// asserts what the implementation produces only says the implementation agrees with itself — which is
// exactly the failure mode of hand-rolling an algorithm, and the reason the ruling had to weigh 953 KB
// against sixty lines rather than treating them as equivalent.
import { describe, it, expect } from 'vitest'
import {
  verifyTotp, totpCode, totpCounter, hotp, base32Encode, base32Decode, generateTotpSecret,
  constantTimeEquals, totpUri, TOTP_STEP_SECONDS,
} from '../auth/totp.js'

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII string below, and the table is quoted verbatim.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii')
const RFC_SECRET = base32Encode(RFC_SEED)
// | time (s)     | TOTP (8 digits, SHA-1) |
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('#651: TOTP against RFC 6238', () => {
  it('produces the published codes at the published times', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(hotp(RFC_SEED, totpCounter(seconds * 1000), 8), `RFC 6238 at t=${seconds}`).toBe(expected)
    }
  })

  it('…and the six-digit form is the same number, which is what a phone shows', () => {
    // 10^6 divides 10^8, so six digits is the tail of eight. Asserted rather than assumed, because it
    // is the step between the RFC's table and what this product actually issues.
    for (const [seconds, eight] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, seconds * 1000), `six digits at t=${seconds}`).toBe(eight.slice(-6))
    }
  })

  it('uses the WHOLE counter, not its low 32 bits', () => {
    // Every vector in the RFC's table lands below 2^32 (the last, t=20000000000, is counter 666666666),
    // so a `writeUInt32BE` on the low half alone passes all six of them. Measured: it did — this case
    // was added after the break check found the table blind to it.
    //
    // Asserted as a PROPERTY rather than against an expected code, because an expected code here could
    // only come from this implementation, which is the circularity the RFC vectors exist to avoid: two
    // counters an exact 2^32 apart must not produce the same code, and they do if the high half is
    // dropped. (The year is ~6053, so this is about the arithmetic being right, not about the date.)
    const low = 1_000
    const high = low + 0x100000000
    expect(hotp(RFC_SEED, high, 8), 'the high half of the counter reaches the HMAC')
      .not.toBe(hotp(RFC_SEED, low, 8))
  })

  it('verifies the code its own clock would produce', () => {
    const now = 1_754_400_000_000
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(totpCounter(now))
  })
})

describe('#651: the window, measured at its edges', () => {
  // The window is the only part of this that is a policy rather than an algorithm, and the boundary is
  // the case that decides whether a code from a minute ago still opens the door. Each side is named.
  const now = 1_754_400_000_000
  const step = TOTP_STEP_SECONDS * 1000
  const secret = generateTotpSecret()

  it('accepts one step behind and one step ahead', () => {
    expect(verifyTotp(secret, totpCode(secret, now - step), now), 'the code that just expired').toBe(totpCounter(now) - 1)
    expect(verifyTotp(secret, totpCode(secret, now + step), now), 'a phone running fast').toBe(totpCounter(now) + 1)
  })

  it('refuses two steps out, on either side', () => {
    expect(verifyTotp(secret, totpCode(secret, now - 2 * step), now), 'two steps behind').toBeNull()
    expect(verifyTotp(secret, totpCode(secret, now + 2 * step), now), 'two steps ahead').toBeNull()
  })

  it('returns WHICH step matched, because refusing a replay needs to know', () => {
    // #657 spends a counter; a boolean would make it recompute one and risk computing a different one.
    const behind = verifyTotp(secret, totpCode(secret, now - step), now)
    expect(behind).toBe(totpCounter(now - step))
    expect(behind).not.toBe(totpCounter(now))
  })

  it('honours a narrower window when asked', () => {
    expect(verifyTotp(secret, totpCode(secret, now - step), now, { window: 0 }), 'window 0 takes only now').toBeNull()
    expect(verifyTotp(secret, totpCode(secret, now), now, { window: 0 })).toBe(totpCounter(now))
  })
})

describe('#651: what it refuses without throwing', () => {
  const now = 1_754_400_000_000
  const secret = generateTotpSecret()

  it('a wrong code, a short code, a long one, letters, and nothing at all', () => {
    // `timingSafeEqual` throws on a length mismatch. Every one of these reaches a caller that expects a
    // boolean answer, and an exception there is a 500 where a "wrong code" belongs.
    for (const bad of ['000000', '12345', '1234567', 'abcdef', '', '  ', '12 34 56']) {
      expect(() => verifyTotp(secret, bad, now), `"${bad}" answers rather than throws`).not.toThrow()
      expect(verifyTotp(secret, bad, now), `"${bad}" is refused`).toBeNull()
    }
  })

  it('a secret that is not base32', () => {
    expect(() => verifyTotp('not!base32!', '123456', now)).not.toThrow()
    expect(verifyTotp('not!base32!', '123456', now)).toBeNull()
  })

  it('but it does accept a code with the whitespace a paste brings', () => {
    const code = totpCode(secret, now)
    expect(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, now), 'pasted in two groups')
      .toBe(totpCounter(now))
  })

  it('and a secret typed in by hand, in groups, in lower case', () => {
    // The manual-entry path exists for a reader whose camera cannot see the QR code; every app that
    // offers it prints the secret in groups of four.
    const grouped = RFC_SECRET.toLowerCase().replace(/(.{4})/g, '$1 ').trim()
    expect(totpCode(grouped, 59 * 1000)).toBe('287082')
  })
})

describe('#651: base32 round-trips, including the lengths that need padding', () => {
  it('returns exactly what went in', () => {
    for (const n of [1, 2, 3, 4, 5, 10, 16, 20, 32, 64]) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255))
      expect(base32Decode(base32Encode(buf)), `${n} bytes`).toEqual(buf)
    }
  })

  it('matches RFC 4648 on the vectors everyone quotes', () => {
    // Encoding that agrees only with this file's own decoder would round-trip perfectly and still be
    // unreadable to every authenticator app.
    expect(base32Encode(Buffer.from('f'))).toBe('MY')
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ')
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6')
    expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ')
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB')
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('a generated secret is 20 bytes of randomness, and two of them differ', () => {
    const a = generateTotpSecret()
    expect(base32Decode(a).length).toBe(20)
    expect(a).not.toBe(generateTotpSecret())
  })
})

describe('#651: the comparison is constant-time and does not throw', () => {
  it('answers false on a length mismatch instead of throwing', () => {
    expect(() => constantTimeEquals('123456', '1234567')).not.toThrow()
    expect(constantTimeEquals('123456', '1234567')).toBe(false)
    expect(constantTimeEquals('123456', '123456')).toBe(true)
    expect(constantTimeEquals('123456', '123457')).toBe(false)
  })
})

describe('#651: the otpauth URI a QR code carries', () => {
  it('names the issuer in both places apps read it from', () => {
    // Older apps read the label prefix; current ones read the parameter. An app given only one files
    // the account under the wrong name, or under none.
    const uri = totpUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'ada@example.test', issuer: 'Wikistead' })
    expect(uri.startsWith('otpauth://totp/Wikistead:ada%40example.test?'), uri).toBe(true)
    const q = new URL(uri).searchParams
    expect(q.get('issuer')).toBe('Wikistead')
    expect(q.get('secret')).toBe('JBSWY3DPEHPK3PXP')
    expect(q.get('algorithm')).toBe('SHA1')
    expect(q.get('digits')).toBe('6')
    expect(q.get('period')).toBe('30')
  })

  it('escapes an account name that would otherwise break the label', () => {
    const uri = totpUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a b/c:d', issuer: 'Wiki Stead' })
    expect(uri, 'no raw slash or colon inside the label').toMatch(/^otpauth:\/\/totp\/Wiki%20Stead:a%20b%2Fc%3Ad\?/)
  })
})
