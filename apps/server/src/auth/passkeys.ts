// Passkeys (#663 / ADR-219 §1). Migration 119.
//
// The verification is `@simplewebauthn/server`'s, deliberately. ADR-219 §9 drew the line: TOTP is sixty
// lines with published test vectors, so it is written here; attestation parsing, COSE keys and CBOR are
// not, and nobody should re-derive them. This file is the product's half — where the challenge lives,
// what the RP is, and which rows come back.
//
// THE RP ID IS THE HOST, and it is computed HERE and nowhere else. #644ruling 4 settled it, and
// the reason it is one function is the reason the `otpauth://` URI is built server-side: a credential
// created under one RP ID cannot be used under another, so a second place computing it differently
// would produce keys that register and never authenticate.
import type IORedis from 'ioredis'
import { randomBytes } from 'node:crypto'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { TenantDb } from '../db/index.js'
import { productName } from '../product-name.js'

/**
 * The Relying Party this browser is talking to: the host it is on, without the port.
 *
 * WebAuthn's RP ID must be the origin's registrable domain or a suffix of it, and this product decides
 * a tenant BY host — so the answer is simply where the request arrived. Ruling 4 accepted the
 * consequence: moving a tenant to its own domain invalidates every enrolled passkey, and the migration
 * flow says so before it commits (#664) rather than in a release note.
 */
export const rpIdFromHost = (host: string | undefined): string => (host ?? '').split(':')[0] ?? ''

/** The full origin the browser will claim, which the library checks the assertion against. */
export const originFromHost = (host: string | undefined): string =>
  `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${host ?? ''}`

// A challenge is a one-shot: issued, presented once, gone. Valkey rather than a table because it has a
// TTL and no history worth keeping — and because a challenge that survives its use is a replay waiting
// for somebody who captured the response.
const CHALLENGE_TTL_S = 300
const key = (tenantId: string, sub: string) => `passkeychal:${tenantId}:${sub}`

export async function putChallenge(valkey: IORedis, tenantId: string, sub: string, challenge: string): Promise<void> {
  await valkey.set(key(tenantId, sub), challenge, 'EX', CHALLENGE_TTL_S)
}

/**
 * Take the challenge, and take it away. GETDEL, not GET-then-DEL: two requests carrying the same
 * captured response would both read it otherwise, and one-shot would be a comment rather than a fact.
 */
export async function takeChallenge(valkey: IORedis, tenantId: string, sub: string): Promise<string | null> {
  return valkey.getdel(key(tenantId, sub))
}

export type StoredPasskey = {
  factorId: string
  credentialId: string
  publicKey: string
  signCount: number
  transports: string[]
  rpId: string
}

/** Every passkey this member holds, confirmed or not — the caller decides which it wants. */
export async function passkeysFor(db: TenantDb, memberSub: string): Promise<StoredPasskey[]> {
  const rows = await db.sql<{
    factor_id: string; credential_id: string; public_key: string; sign_count: string; transports: string[]; rp_id: string
  }[]>`
    SELECT p.factor_id, p.credential_id, p.public_key, p.sign_count::text, p.transports, p.rp_id
    FROM member_passkeys p JOIN member_factors f ON f.id = p.factor_id
    WHERE f.member_sub = ${memberSub}`
  return rows.map((r) => ({
    factorId: r.factor_id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    signCount: Number(r.sign_count),
    transports: r.transports,
    rpId: r.rp_id,
  }))
}

/**
 * The options a browser needs to create a credential, and the challenge banked beside them.
 *
 * `excludeCredentials` carries what this member already holds, so an authenticator they have used
 * before declines rather than silently making a second credential — two rows for one key, the second
 * with a sign counter that starts behind.
 *
 * `authenticatorSelection` deliberately does NOT constrain the attachment: the acceptance names a phone
 * (platform) AND a YubiKey (cross-platform), and asking for one shuts out the other.
 */
export async function passkeyRegistrationOptions(
  deps: { db: TenantDb; valkey: IORedis },
  args: { tenantId: string; memberSub: string; memberName: string; host: string | undefined },
) {
  const held = await passkeysFor(deps.db, args.memberSub)
  const options = await generateRegistrationOptions({
    rpName: productName(),
    rpID: rpIdFromHost(args.host),
    // The handle the authenticator stores. Random rather than the sub: it ends up on the device and in
    // some password managers' UI, and a subject identifier is not something to scatter there.
    userID: randomBytes(32),
    userName: args.memberName,
    attestationType: 'none', // this product does not vet authenticator models; asking would collect data it will not use
    excludeCredentials: held.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
  await putChallenge(deps.valkey, args.tenantId, args.memberSub, options.challenge)
  return options
}

export type VerifiedPasskey = {
  credentialId: string
  publicKey: string
  signCount: number
  transports: string[]
  rpId: string
}

/**
 * Check what the browser sent. Returns null when it does not verify — the caller's next line is "then
 * that did not work", and the distinctions the library makes are not ones a member can act on.
 *
 * The challenge is consumed whatever the outcome (`takeChallenge`): a failed attempt must not leave a
 * live challenge for a second, better-formed try.
 */
export async function verifyPasskeyRegistration(
  deps: { valkey: IORedis },
  args: { tenantId: string; memberSub: string; host: string | undefined; response: RegistrationResponseJSON },
): Promise<VerifiedPasskey | null> {
  const expectedChallenge = await takeChallenge(deps.valkey, args.tenantId, args.memberSub)
  if (!expectedChallenge) return null
  const rpID = rpIdFromHost(args.host)
  try {
    const verified = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge,
      expectedOrigin: originFromHost(args.host),
      expectedRPID: rpID,
      requireUserVerification: false,
    })
    if (!verified.verified || !verified.registrationInfo) return null
    const c = verified.registrationInfo.credential
    return {
      credentialId: c.id,
      publicKey: Buffer.from(c.publicKey).toString('base64url'),
      signCount: c.counter,
      transports: (args.response.response.transports ?? []) as string[],
      rpId: rpID,
    }
  } catch {
    // A malformed or mismatched response is an answer, not an exception: it reaches a caller expecting
    // "did this work", and a 500 there would say the product is broken when the browser simply said no.
    return null
  }
}

/** Attach the verified credential to a factor row. Both are written together or neither is. */
export async function storePasskey(
  db: TenantDb,
  args: { tenantId: string; factorId: string; passkey: VerifiedPasskey },
): Promise<void> {
  await db.sql`
    INSERT INTO member_passkeys (factor_id, tenant_id, credential_id, public_key, sign_count, transports, rp_id)
    VALUES (${args.factorId}, ${args.tenantId}, ${args.passkey.credentialId}, ${args.passkey.publicKey},
            ${args.passkey.signCount}, ${args.passkey.transports}, ${args.passkey.rpId})`
}

/**
 * How many members hold a passkey that a move to `newRpId` would invalidate.
 *
 * Here rather than in the domain flow, because the fact is about credentials: #664 needs a number to
 * decide whether to warn at all, and a warning shown to a tenant with nothing to lose is one nobody
 * reads the next time.
 */
export async function passkeysStrandedBy(db: TenantDb, newRpId: string): Promise<number> {
  const [row] = await db.sql<[{ n: number }?]>`
    SELECT count(DISTINCT f.member_sub)::int AS n
    FROM member_passkeys p JOIN member_factors f ON f.id = p.factor_id
    WHERE f.confirmed_at IS NOT NULL AND p.rp_id <> ${newRpId}`
  return row?.n ?? 0
}
