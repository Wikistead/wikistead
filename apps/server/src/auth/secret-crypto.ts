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

// #690: secrets whose values are PUBLISHED — committed in this repository's public fixtures
// (.env.e2e, .env.server-test, .env.example) and, for the encryption key, a historical env backup.
// A published key still decodes to 32 perfectly valid bytes, so the length assert above happily
// boots production on it. The values are spelled here as literals on purpose: they are already
// public by definition (that is the defect), and the literal is what a grep can find.
//
// A test derives this table from the fixture files themselves, so changing a fixture value without
// adding the NEW published value here is red, not silent.
export const PUBLISHED_FIXTURE_SECRETS: Readonly<Record<string, readonly string[]>> = {
  OIDC_SECRET_ENC_KEY: ['7yMsXpBHk5/8edVzkeyWcjhYQTyj7EZDAd3Mz6KQHFo='],
  GUEST_TOKEN_SECRET: ['e2e_guest_secret', 'server_test_guest_secret', 'dev_guest_secret_change_me'],
  MEILI_MASTER_KEY: ['dev_master_key_change_me'],
  // #1081: the S3 fixture identity ships in infra/seaweedfs/s3.json and .env.example — production
  // booting on it would open the object store with a key the public repository publishes.
  S3_ACCESS_KEY: ['wksadmin'],
  S3_SECRET_KEY: ['wksadmin'],
}

// #690: refuse to BOOT production on a published secret (same safety-valve shape as the entitlements
// and secret-key asserts above — a configuration error surfaces at deploy time, loudly, never as a
// quietly guessable production key). Dev and the test stacks run on exactly these values by design,
// so anything but NODE_ENV=production passes untouched.
export function assertNoPublishedSecretsInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  for (const [name, published] of Object.entries(PUBLISHED_FIXTURE_SECRETS)) {
    const value = env[name]
    if (value && published.includes(value)) {
      throw new Error(
        `${name} is set to a key that is published in the public repository's fixtures — ` +
        'generate a fresh secret for production (refusing to start)',
      )
    }
  }
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
