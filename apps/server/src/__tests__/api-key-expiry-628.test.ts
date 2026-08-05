// Integration — real Postgres. #628 / ADR-215 §1: an API key can be given a lifetime.
//
// Before this, the only way a key stopped working was somebody revoking it by hand, so a leaked one
// lived forever. The expiry is enforced in the SAME clause as the revocation gate, deliberately: the two
// answer one question — may this credential still speak — and a second gate elsewhere could drift.
//
// The migration's whole promise is that it changes no row, so "an existing key still works" is pinned as
// hard as "an expired one does not".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { verifyApiKey } from '../api-key-auth.js'
import { createApiKey, getApiKeyMaxAgeDays, setApiKeyMaxAgeDays } from '../routes/api-keys.js'
import { fgaClient } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let db: TenantDb

beforeAll(async () => { db = await acquireTenantDb(asTenant(T)) }, 120_000)
afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${`exp628-%`}`.catch(() => {})
  await admin`UPDATE tenant_settings SET api_key_max_age_days = NULL WHERE tenant_id = ${T}`.catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 60_000)

const mint = (name: string, expiresInDays: number | null = null) =>
  createApiKey(db, { tenantId: T, plan: 'business', ownerUserId: OWNER, name: `exp628-${name}-${STAMP}`, expiresInDays })

describe('#628: a key can be given a lifetime, and stops working when it ends', () => {
  it('a key with no expiry authenticates — the migration changed nothing', async () => {
    const k = await mint('forever')
    expect(k.expiresAt, 'no lifetime asked for, none given').toBeNull()
    const r = await verifyApiKey(k.plaintext, T)
    expect(r && 'sub' in r ? r.sub : null, 'and it works exactly as before').toBe(OWNER)
  }, 60_000)

  it('a key with a FUTURE expiry authenticates', async () => {
    const k = await mint('future', 30)
    expect(k.expiresAt, 'the lifetime came back').toBeTruthy()
    const r = await verifyApiKey(k.plaintext, T)
    expect(r && 'sub' in r ? r.sub : null).toBe(OWNER)
  }, 60_000)

  it('a key whose expiry has PASSED does not', async () => {
    // Backdated in the row rather than by waiting: the assertion is about the clause, not about clocks.
    const k = await mint('past', 30)
    await admin`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = ${k.id}`
    const r = await verifyApiKey(k.plaintext, T)
    expect(r && 'sub' in r, 'an expired key does not authenticate').toBeFalsy()
    expect(r && 'expired' in r, 'and it is refused AS expired, so the log can say so (ADR-215 §5)').toBe(true)
  }, 60_000)

  it('the CALLER cannot tell an expired key from a revoked one', async () => {
    // The log distinguishes them (ADR-215 §5 — "the key stopped working" is an audit question), the
    // caller does not: both end as the same 401. Answering an expired key differently would confirm to
    // somebody holding a stale credential that a key with that prefix once existed.
    const expired = await mint('shape-a', 30)
    await admin`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = ${expired.id}`
    const revoked = await mint('shape-b')
    await admin`UPDATE api_keys SET revoked_at = now() WHERE id = ${revoked.id}`
    const e = await verifyApiKey(expired.plaintext, T)
    const r = await verifyApiKey(revoked.plaintext, T)
    // neither authenticates…
    expect(e && 'sub' in e, 'an expired key does not authenticate').toBeFalsy()
    expect(r, 'a revoked key does not authenticate').toBeNull()
    // …and the route turns both into the same answer, which is what the caller sees
    expect(e && 'expired' in e, 'the server knows which it was, for the log').toBe(true)
  }, 60_000)
})

describe("#628: the tenant's ceiling on how long a key may live", () => {
  it('no ceiling by default — every tenant starts where it already was', async () => {
    expect(await getApiKeyMaxAgeDays(db)).toBeNull()
  }, 60_000)

  it('under the ceiling is allowed; over it is REFUSED rather than quietly shortened', async () => {
    await setApiKeyMaxAgeDays(db, fgaClient, { tenantId: T, userId: OWNER, maxAgeDays: 7 })
    try {
      const ok = await mint('under', 3)
      expect(ok.expiresAt, 'a request inside the ceiling is granted').toBeTruthy()
      // Shortening silently would leave the caller believing they had a year, and finding out when the
      // automation stopped. Refusing says it while they are still looking at the screen.
      await expect(mint('over', 3650), 'asking for longer is refused').rejects.toMatchObject({ statusCode: 403, code: 'expiry_capped' })
      // …and so is asking for NO expiry, which is longer than any ceiling
      await expect(mint('none-under-cap', null), 'no expiry at all is also over the ceiling').rejects.toMatchObject({ code: 'expiry_capped' })
    } finally {
      await setApiKeyMaxAgeDays(db, fgaClient, { tenantId: T, userId: OWNER, maxAgeDays: null })
    }
  }, 120_000)

  it('a nonsense lifetime is refused before anything is written', async () => {
    await expect(mint('bad', 0), 'zero days').rejects.toMatchObject({ statusCode: 400, code: 'invalid_expiry' })
    await expect(mint('bad2', 1.5), 'a fraction of a day').rejects.toMatchObject({ code: 'invalid_expiry' })
    const [row] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM api_keys WHERE name LIKE ${`exp628-bad%`}`
    expect(row!.n, 'and nothing was written').toBe(0)
  }, 60_000)
})
