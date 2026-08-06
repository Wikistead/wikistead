// TOTP (RFC 6238), by hand (#651 / ADR-219 §9).
//
// `otpauth` would do this in one import, and the ruling declined it: 953 KB and a new dependency, for an
// HMAC, a counter and a window. It is the same trade `password-hash.ts:3` made when it chose scrypt out
// of node:crypto — and unlike WebAuthn's attestation parsing, which nobody should re-derive, this
// algorithm is thirty lines and has published test vectors to check them against.
//
// SHA-1 is not an oversight. RFC 6238 allows SHA-256 and SHA-512, and every authenticator app in
// circulation implements the SHA-1 default; an enrolment the reader's phone cannot verify is worse than
// a hash whose weakness (collisions) does not apply to HMAC.
//
// The clock is a PARAMETER here, never `Date.now()`. A verifier that reads the clock can only be
// observed, not asserted: the window is ±1 step, so the boundary — the case that decides whether a
// stale code is accepted — is unreachable from a test that cannot say what time it is.
//
// What is NOT here, deliberately: replay refusal. A code is valid for its whole window by construction,
// so "already used" is a fact about a member and a counter, which lives in the database (#657). Putting
// half of it here would add a branch nothing can reach until that arrives — a test passing over code
// that never runs.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Seconds per step. 30 is the RFC's default and what every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30
/** Digits shown. 6 is the RFC's default; 8 exists and no consumer app offers it. */
export const TOTP_DIGITS = 6
/**
 * Steps of clock skew tolerated either side. ±1 means a code is accepted for ~90 seconds in total,
 * which is the usual compromise between a phone whose clock has drifted and a code that outlives the
 * screen it was read from.
 */
export const TOTP_WINDOW_STEPS = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** A shared secret, base32 as every authenticator app expects it. 20 bytes = the RFC's SHA-1 key size. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

/** RFC 4648 base32, unpadded — what `otpauth://` URIs carry and what a phone accepts when typed in. */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * The inverse. Padding and lower case are accepted, and so are spaces — a secret that was typed in by
 * hand arrives in groups of four, and refusing it there would be refusing the enrolment path that exists
 * for readers whose camera cannot see the QR code.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** HOTP (RFC 4226): the counter as 8 big-endian bytes, HMAC-SHA1, dynamic truncation, modulo. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8)
  // A step counter passes 2^32 in the year 6053, but `writeUInt32BE` on the low half alone would be a
  // silent wrap; the high half is written from the value divided down rather than assumed zero.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac('sha1', secret).update(buf).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** Which step a moment falls in. `nowMs` is a parameter for the reason at the top of this file. */
export const totpCounter = (nowMs: number, step = TOTP_STEP_SECONDS): number =>
  Math.floor(nowMs / 1000 / step)

/** The code for a moment — what the reader's phone is showing. */
export function totpCode(secretBase32: string, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpCounter(nowMs), digits)
}

/**
 * Verify a code, tolerating skew.
 *
 * Returns the counter that matched, or `null`. The counter is returned rather than a boolean because
 * refusing a replay (#657) needs to know WHICH step was spent — "the last accepted counter" is the
 * whole mechanism, and a boolean would force the caller to recompute it and get it subtly different.
 *
 * Every candidate is compared even after one matches. An early return would make the number of HMACs
 * depend on how close the guess was, which is a timing signal about the secret; the constant-time
 * comparison below would be pointless with a variable-time loop around it.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  opts: { window?: number; digits?: number; step?: number } = {},
): number | null {
  const window = opts.window ?? TOTP_WINDOW_STEPS
  const digits = opts.digits ?? TOTP_DIGITS
  const step = opts.step ?? TOTP_STEP_SECONDS
  // Whitespace is what a reader's paste brings with it; anything else is not a code and is refused
  // here rather than compared, since a non-digit can never match a digit string.
  const given = code.replace(/\s/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(given)) return null

  let secret: Buffer
  try {
    secret = base32Decode(secretBase32)
  } catch {
    return null
  }

  const centre = totpCounter(nowMs, step)
  let matched: number | null = null
  for (let offset = -window; offset <= window; offset++) {
    const counter = centre + offset
    if (counter < 0) continue
    if (constantTimeEquals(hotp(secret, counter, digits), given)) matched = counter
  }
  return matched
}

/**
 * Equal-length constant-time string compare.
 *
 * `timingSafeEqual` throws on a length mismatch, which would turn "wrong length" into an exception at a
 * call site expecting a boolean. The length is checked first and the result is a plain false: the codes
 * here are a fixed number of digits, so length carries nothing about the secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * The `otpauth://` URI a QR code carries.
 *
 * `issuer` appears twice on purpose — as a label prefix and as a parameter. The prefix is what older
 * apps read; the parameter is what current ones read, and an app given only one of them files the
 * account under the wrong name or under no name at all.
 */
export function totpUri(args: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(args.issuer)}:${encodeURIComponent(args.account)}`
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
