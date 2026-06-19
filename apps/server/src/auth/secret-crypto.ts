// At-rest encryption for tenant OIDC client secrets (P1.1 C3).
// AES-256-GCM with a 32-byte key from OIDC_SECRET_ENC_KEY (base64).
//
// FAIL-CLOSED: the key is asserted at boot (assertSecretKey, called from
// buildApp). If it is missing or the wrong length the server refuses to start,
// rather than silently degrading to plaintext secret storage — same discipline
// as the entitlements boot assert.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_ENV = 'OIDC_SECRET_ENC_KEY'
const IV_LEN = 12
const TAG_LEN = 16

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV]
  if (!raw) {
    throw new Error(`${KEY_ENV} is not set — refusing to start (would risk plaintext OIDC secret storage)`)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to 32 bytes (base64 AES-256 key); got ${key.length}`)
  }
  return key
}

// Boot assert — call once at startup so a missing/short key fails the deploy
// loudly instead of failing open to plaintext.
export function assertSecretKey(): void {
  loadKey()
}

// Returns base64(iv || ciphertext || tag).
export function encryptSecret(plaintext: string): string {
  const key = loadKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

export function decryptSecret(enc: string): string {
  const key = loadKey()
  const buf = Buffer.from(enc, 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
