import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// #1141 / ADR-220 §4.2 rev12: an opaque, ENCRYPTED continuation cursor for the placeholder walk.
//
// rev12 (design-review): the first version of this module followed `search/cursor.ts`'s shape
// (base64url the body, HMAC it) verbatim — correct for THAT cursor, whose body is a bare scan offset
// with no authz-sensitive content, but wrong here: this module's body carries real invisible-page and
// candidate ids (`Frontier.invisibleId`, `GrantsPathState`'s candidate list, the guest walk's
// `GuestWorkItem` ids) — exactly the ADR-220 §4.1/§4.2 opacity guarantee ("carries no field the client
// could read a real page id... out of") this ticket exists to preserve across a resume boundary.
// base64url is an ENCODING, not a secret — a signed-but-plaintext body is trivially decoded by anyone
// without the key, which would hand a restricted-scope caller or an idle curious guest the ids and
// shape of a subtree they were never shown. AES-256-GCM (the same primitive `auth/secret-crypto.ts`
// uses for at-rest OIDC secrets) closes that: the state is unrecoverable without the key, and GCM's own
// auth tag gives tamper-evidence for free — no separate HMAC needed.
//
// Consequences, identical in kind to `search/cursor.ts`'s:
//   - opaque: the state is genuinely unreadable without the key (encrypted, not just encoded).
//   - tamper-evident: any change to the ciphertext or tag fails authentication.
//   - scope-bound: the (tenant, subject, space, branch) scope is passed as GCM Additional
//     Authenticated Data (AAD) — bound into the auth tag but never itself stored in the cursor, so a
//     cursor minted for one scope fails to even DECRYPT against a different one (not merely "does not
//     match after decoding" — there is nothing to compare; decryption itself throws).
//   - time-bound: an embedded expiry (`CURSOR_TTL_MS`) bounds how long a stale-at-mint-time visibility
//     grant can be replayed — defense in depth alongside the reveal-time authz recheck (§4.4 note in
//     `resolveGuestPlaceholders`'s caller), not a substitute for it.
//   - size-bucketed (design-review N4): AES-GCM does not pad, so the plaintext's exact byte length —
//     and with it, roughly how many candidates/frontier nodes remain queued — would otherwise be
//     recoverable from the cursor STRING's length alone, without the key. The plaintext is padded
//     (PKCS#7-style, `PAD_BLOCK`-byte buckets) before encryption, so the visible length only narrows the
//     remaining count to a bucket, not an exact value — a real, if smaller, residual channel than none
//     at all (a huge state and a huge-plus-one-byte state can still land in different buckets).
// On ANY verification failure the caller starts the walk fresh (decode returns undefined) — the same
// safe, non-leaking default `search/cursor.ts` uses, never an error that would itself be an oracle on
// whether the cursor was well-formed.
export interface PlaceholderCursorScope {
  tenantId: string
  subject: string
  spaceId: string
  branchParentId: string | null
}

const IV_LEN = 12
const TAG_LEN = 16
// PKCS#7-style padding, bucket size 128 bytes (fits the pad value in a single byte: 1..128). Chosen to
// collapse the common case — a handful of queued ids — into few buckets, without inflating every
// cursor to one fixed (and therefore very large) size regardless of how little state it actually holds.
const PAD_BLOCK = 128

function pad(buf: Buffer): Buffer {
  const padLen = PAD_BLOCK - (buf.length % PAD_BLOCK)
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)])
}

function unpad(buf: Buffer): Buffer {
  const padLen = buf.length > 0 ? buf[buf.length - 1]! : 0
  if (padLen < 1 || padLen > PAD_BLOCK || padLen > buf.length) throw new Error('bad padding')
  return buf.subarray(0, buf.length - padLen)
}
// A reader who keeps a tab open and scrolls a very large tree over many minutes is the normal case
// this bounds against; an attacker replaying a cursor minted before a permission was revoked is the
// abnormal one. 15 minutes is generous for the former and short for the latter — no existing constant
// in this codebase governs a continuation-style cursor's own lifetime (search's own cursor, #103/
// ADR-068, carries no expiry at all — its body is a bare offset, not an authz-sensitive id).
const CURSOR_TTL_MS = 15 * 60 * 1000

// #1141 rev12 (design-review S1): FAIL-CLOSED, matching `auth/secret-crypto.ts`'s own discipline for
// at-rest encryption — a placeholder cursor's plaintext is a set of real page ids, so signing (now
// encrypting) it with an empty key would make it silently forgeable rather than merely refusing to
// mint one. The previous `|| ''` fallback let both env vars be unset and still "work".
function deriveKey(): Buffer {
  const raw = process.env.PLACEHOLDER_CURSOR_SECRET || process.env.GUEST_TOKEN_SECRET
  if (!raw) {
    throw new Error(
      'PLACEHOLDER_CURSOR_SECRET (or GUEST_TOKEN_SECRET) is not set — refusing to mint a placeholder-walk ' +
      'continuation cursor with a forgeable key',
    )
  }
  // AES-256-GCM needs a 32-byte key; the env var is an arbitrary-length secret STRING (shared with
  // `search/cursor.ts`'s HMAC and the guest token), so it is hashed down to exactly 32 bytes rather
  // than requiring a new dedicated base64-encoded key + boot assert (`OIDC_SECRET_ENC_KEY`'s own
  // shape) for what is, unlike an at-rest secrets store, a short-lived, itself-rotatable cursor.
  return createHash('sha256').update(raw).digest()
}

// The scope is authenticated (bound into the GCM tag) but is not itself PART OF the cursor's plaintext
// — nothing to decrypt back out and compare, so there is no risk of it round-tripping into the body by
// accident the way a plain HMAC's signed-but-visible fields could.
function scopeAad(ctx: PlaceholderCursorScope): Buffer {
  return Buffer.from(`${ctx.tenantId}\x00${ctx.subject}\x00${ctx.spaceId}\x00${ctx.branchParentId ?? ''}`, 'utf8')
}

export function encodePlaceholderCursor<T>(state: T, ctx: PlaceholderCursorScope): string {
  const key = deriveKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(scopeAad(ctx))
  const payload = pad(Buffer.from(JSON.stringify({ exp: Date.now() + CURSOR_TTL_MS, state }), 'utf8'))
  const ct = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64url')
}

/** Returns the decoded state, or `undefined` for an absent / malformed / tampered / cross-scope /
 * expired cursor — the caller's cue to start the walk from the top, exactly like a request with no
 * cursor at all. Never throws. */
export function decodePlaceholderCursor<T>(cursor: string | undefined, ctx: PlaceholderCursorScope): T | undefined {
  if (!cursor) return undefined
  try {
    const key = deriveKey()
    const buf = Buffer.from(cursor, 'base64url')
    if (buf.length < IV_LEN + TAG_LEN) return undefined
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(scopeAad(ctx))
    decipher.setAuthTag(tag)
    const plaintext = unpad(Buffer.concat([decipher.update(ct), decipher.final()])).toString('utf8')
    const { exp, state } = JSON.parse(plaintext) as { exp: number; state: T }
    if (typeof exp !== 'number' || Date.now() > exp) return undefined
    return state
  } catch {
    // Wrong key, wrong scope (AAD mismatch), tampered ciphertext/tag, or malformed base64/JSON — all
    // indistinguishable from the caller's point of view, and all restart the walk, never throw.
    return undefined
  }
}
