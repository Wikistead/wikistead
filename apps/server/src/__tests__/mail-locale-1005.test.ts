// #1005 / ADR-260 §3.1/§5: the mail locale fallback — the member's own `locale`, then
// `tenant_settings.default_lang`, then `en` — resolved once per recipient inside the drain's tenant
// tx (members and tenant_settings are FORCE RLS) and carried on the builder's ctx, never guessed from
// a request header (there is no request at drain time).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { registerEmailBuilder, drainEmailOutbox, enqueueEmailOutbox } from '../email/outbox.js'
import type { Lang } from '../locale.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `mail-locale-${STAMP}`
const ADMIN_SUB = `mail-locale-admin-${STAMP}`
const CLASS = `mail-locale-${STAMP}`

let tenantId = ''
let seen: { sub: string; locale: Lang }[] = []

beforeAll(async () => {
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  registerEmailBuilder(CLASS, async (rows, ctx) => {
    seen.push({ sub: rows[0]!.member_sub, locale: ctx.locale })
    return { kind: 'skip', reason: 'this pin never sends' }
  })
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM email_outbox WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenant_settings WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end(); await pool.end()
}, 60_000)

const drain = () => drainEmailOutbox({ fallback: { send: async () => {} }, batch: 50 })
const setDefaultLang = (lang: string | null) =>
  admin`INSERT INTO tenant_settings (tenant_id, default_lang) VALUES (${tenantId}, ${lang})
        ON CONFLICT (tenant_id) DO UPDATE SET default_lang = EXCLUDED.default_lang`
const addMember = (sub: string, locale: string | null) =>
  admin`INSERT INTO members (tenant_id, sub, display_name, email, locale) VALUES (${tenantId}, ${sub}, ${sub}, ${`${sub}@e2e.test`}, ${locale})`

describe('#1005 mail locale fallback (ADR-260 §3.1)', () => {
  it('the member locale wins over the tenant default, resolved per-recipient within ONE drain pass', async () => {
    await setDefaultLang('en')
    const withLocale = `1005-ja-${STAMP}`, withoutLocale = `1005-none-${STAMP}`
    await addMember(withLocale, 'ja')
    await addMember(withoutLocale, null)
    seen = []
    await enqueueEmailOutbox([
      { tenantId, memberSub: withLocale, class: CLASS },
      { tenantId, memberSub: withoutLocale, class: CLASS },
    ])
    await drain()
    const bySub = Object.fromEntries(seen.map((s) => [s.sub, s.locale]))
    expect(bySub[withLocale], "the member's own locale wins").toBe('ja')
    expect(bySub[withoutLocale], 'no member locale — falls to the tenant default, in the SAME pass').toBe('en')
  }, 60_000)

  it("the tenant default alone resolves the mail — break-check: drop the tenant step and this reddens", async () => {
    await setDefaultLang('ja')
    const sub = `1005-tenantonly-${STAMP}`
    await addMember(sub, null)
    seen = []
    await enqueueEmailOutbox([{ tenantId, memberSub: sub, class: CLASS }])
    await drain()
    expect(seen[0]!.locale, 'no member locale; tenant default_lang is ja').toBe('ja')
  }, 60_000)

  it('both unset resolves to en — the state of every deployment that exists today', async () => {
    await setDefaultLang(null)
    const sub = `1005-bothunset-${STAMP}`
    await addMember(sub, null)
    seen = []
    await enqueueEmailOutbox([{ tenantId, memberSub: sub, class: CLASS }])
    await drain()
    expect(seen[0]!.locale).toBe('en')
  }, 60_000)

  it('an unknown locale value on the member falls through to the tenant default instead of erroring', async () => {
    await setDefaultLang('ja')
    const sub = `1005-garbage-${STAMP}`
    await addMember(sub, 'xx-not-a-real-locale')
    seen = []
    await enqueueEmailOutbox([{ tenantId, memberSub: sub, class: CLASS }])
    await drain()
    expect(seen[0]!.locale).toBe('ja')
  }, 60_000)
})
