// #419: the personal-space initial name is localized by the TENANT default language (tenant_settings.
// default_lang — v1's ONLY consumer of that column). ja → the Japanese "X's Space" wording, en/unset → "X's Space"; an
// empty display name falls back per-language. Existing spaces are never renamed (ensurePersonalSpace
// short-circuits on the existing row — pinned here). Real Postgres (the dev tenant's settings row is
// flipped and restored around the ja assertions).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { tenantDefaultLang, personalSpaceName } from '../auth/session.js'
import { ensurePersonalSpace } from '../routes/spaces.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant
let db: TenantDb
const SUB = `p419-${Date.now().toString(36)}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
}, 30_000)

afterAll(async () => {
  await admin`UPDATE tenant_settings SET default_lang = NULL WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM spaces WHERE personal_owner_sub = ${SUB}`
  await db.release()
  await pool.end()
  await admin.end()
}, 30_000)

describe('personalSpaceName (#419 — pure)', () => {
  it('composes per language, with per-language empty-name fallbacks', () => {
    expect(personalSpaceName('Alex', 'ja')).toBe('Alexのスペース')
    expect(personalSpaceName('Alex', 'en')).toBe("Alex's Space")
    expect(personalSpaceName('', 'ja')).toBe('マイスペース')
    expect(personalSpaceName('', 'en')).toBe('Personal Space')
  })
})

describe('tenantDefaultLang + first-login naming (#419 — real PG)', () => {
  it("unset → 'en'; 'ja' → 'ja'; unknown values fall back to 'en'", async () => {
    await admin`UPDATE tenant_settings SET default_lang = NULL WHERE tenant_id = ${tenant.id}`
    expect(await tenantDefaultLang(db)).toBe('en')
    await admin`UPDATE tenant_settings SET default_lang = 'ja' WHERE tenant_id = ${tenant.id}`
    expect(await tenantDefaultLang(db)).toBe('ja')
    await admin`UPDATE tenant_settings SET default_lang = 'fr' WHERE tenant_id = ${tenant.id}`
    expect(await tenantDefaultLang(db)).toBe('en')
  })

  it('a ja-tenant first login creates 「Xのスペース」; a later login never renames it', async () => {
    await admin`UPDATE tenant_settings SET default_lang = 'ja' WHERE tenant_id = ${tenant.id}`
    const name = personalSpaceName('Alex', await tenantDefaultLang(db))
    await ensurePersonalSpace(db, fgaClient, { tenantId: tenant.id, userId: SUB, name, plan: tenant.plan })
    const [row] = await admin<{ name: string }[]>`SELECT name FROM spaces WHERE personal_owner_sub = ${SUB}`
    expect(row?.name).toBe('Alexのスペース')

    // The tenant flips to en and the member logs in again — the EXISTING space keeps its name.
    await admin`UPDATE tenant_settings SET default_lang = NULL WHERE tenant_id = ${tenant.id}`
    const name2 = personalSpaceName('Alex', await tenantDefaultLang(db))
    expect(name2).toBe("Alex's Space")
    await ensurePersonalSpace(db, fgaClient, { tenantId: tenant.id, userId: SUB, name: name2, plan: tenant.plan })
    const [row2] = await admin<{ name: string }[]>`SELECT name FROM spaces WHERE personal_owner_sub = ${SUB}`
    expect(row2?.name).toBe('Alexのスペース') // unchanged — never renamed after creation
  })
})
