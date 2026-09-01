// #1008 review bounce: the escapes that commit ebeff920 introduced had no regression
// pin. The reset link is built from `req.headers.host` and the invite mail interpolates the URL, the
// tenant slug and the product name into raw HTML — all of them went through `esc` for the first time
// in that commit, and removing any one of those `esc` calls left every suite green. This file holds
// that boundary: it captures the three request-path sends (reset, invite create, invite re-issue)
// through the hooks seam and asserts a HOSTILE Host header lands escaped in the wire message, and
// that the Japanese rendering reaches the wire too (the catalogue being bilingual is pinned
// elsewhere; a builder that never consults it would still pass those pins).
//
// The hostile Host works because the tenant resolver reads `host.split(':')[0]` — everything after
// the first colon stays out of tenant resolution but IS part of `req.headers.host`, which is exactly
// the injection channel: the attacker controls the header, the product controls the parse.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { registerEmailDriver, type EmailMessage } from '@wikistead/hooks'
import { enrolUnderSeatCap, createInvite } from '../auth/invites.js'
import { hashPassword } from '../auth/password-hash.js'
import { productName } from '../product-name.js'
import { resetSubject, resetLinkLabel, inviteSubject, inviteAcceptLabel } from '../email/catalog.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)

// The payload rides BEHIND the colon: `split(':')[0]` still resolves tenant_dev, and the raw header
// (payload included) is what the route interpolates into `<a href="...">`.
const HOSTILE_HOST = 'dev.localhost:80"><script>alert(1)</script>'
const RAW_MARKER = '"><script>'
const ESCAPED_MARKER = '&quot;&gt;&lt;script&gt;'

let app: FastifyInstance
let db: TenantDb
// The invite mail interpolates `req.tenant.slug`, which is NOT the tenant id ('dev', not
// 'tenant_dev') — read it rather than assume it, so the pin measures what the route actually wrote.
let tenantSlug: string

// Registered through the module-global seam — `resolveTenantEmailDriver` consults it before the
// app's fallback, so every send in this worker process lands here instead of the no-op driver.
const sent: EmailMessage[] = []
registerEmailDriver({ send: async (m) => { sent.push(m) } })

// The reset send is deliberately detached (fire-and-forget, so the endpoint's clock stays uniform);
// the invite sends are awaited. Poll for both, so the pin never races the detachment.
async function nextMessage(from: number): Promise<EmailMessage> {
  for (let i = 0; i < 100; i++) {
    if (sent.length > from) return sent[from]!
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no email was captured within 5s')
}

const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
const setDefaultLang = (lang: string | null) =>
  db.sql`INSERT INTO tenant_settings (tenant_id, default_lang) VALUES (${TENANT}, ${lang})
         ON CONFLICT (tenant_id) DO UPDATE SET default_lang = ${lang}`

const localSub = `wlocal_mi1008-${STAMP}`
const localAddr = `mi1008-${STAMP}@e2e.test`
const inviteAddr = (n: string) => `mi1008-inv-${n}-${STAMP}@e2e.test`

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  tenantSlug = (await adminPool<{ slug: string }[]>`SELECT slug FROM tenants WHERE id = ${TENANT}`)[0]!.slug
  await setLocalLogin(true)
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub: localSub, email: localAddr }, 'member', 'invite', 'local'))
  await db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
               VALUES (${TENANT}, ${localSub}, ${localAddr}, ${await hashPassword('the-original-passphrase')})`
  // The reset path resolves the MEMBER locale (three-step chain, first step) — set it here so the
  // Japanese assertion measures the wire, not the tenant default.
  await db.sql`UPDATE members SET locale = 'ja' WHERE sub = ${localSub}`
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  await adminPool`DELETE FROM password_resets WHERE member_sub = ${localSub}`.catch(() => {})
  await adminPool`DELETE FROM local_credentials WHERE member_sub = ${localSub}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${localSub}`.catch(() => {})
  await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email LIKE ${`mi1008-inv-%-${STAMP}@e2e.test`}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#1008: what the three request-path mails put on the wire', () => {
  it('the reset mail escapes a hostile Host in its href, and renders Japanese for a ja member', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/auth/local/reset-request',
      headers: { host: HOSTILE_HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: JSON.stringify({ identifier: localAddr }),
    })
    expect(res.statusCode, 'the uniform answer').toBe(204)
    const msg = await nextMessage(from)
    expect(msg.to).toBe(localAddr)
    // The boundary itself: the hostile fragment must land escaped and MUST NOT land raw. Both sides,
    // because an implementation that drops the link entirely would pass the "no raw" half alone.
    expect(msg.html, 'the payload never lands as markup').not.toContain(RAW_MARKER)
    expect(msg.html, 'the payload lands escaped inside the href').toContain(ESCAPED_MARKER)
    expect(msg.html, 'the link is still a link').toContain('href="http://dev.localhost:80')
    expect(msg.html).toContain('/reset-password?token=')
    // The Japanese face of THIS mail (the catalogue's own en≠ja is pinned elsewhere; this asserts
    // the builder consults it): subject and anchor label are the ja entries, not the en ones.
    expect(msg.subject).toBe(resetSubject('ja', productName()))
    expect(msg.html).toContain(resetLinkLabel('ja'))
    expect(msg.html, 'no English anchor label on a ja mail').not.toContain(resetLinkLabel('en'))
    expect(msg.text, 'the text part carries the raw link (no entities)').toContain('http://dev.localhost:80"><script>')
  })

  it('the invite-create mail escapes the hostile Host and wraps the slug in the builder-owned markup', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/members/invites',
      headers: { ...AUTH, host: HOSTILE_HOST },
      payload: JSON.stringify({ email: inviteAddr('create'), role: 'member' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().emailed, 'the route reports the send').toBe(true)
    const msg = await nextMessage(from)
    expect(msg.to).toBe(inviteAddr('create'))
    expect(msg.html, 'the payload never lands as markup').not.toContain(RAW_MARKER)
    expect(msg.html, 'the payload lands escaped inside the href').toContain(ESCAPED_MARKER)
    expect(msg.html).toContain('/invite?token=')
    // The slug and product name pass through esc and land inside builder-owned tags (§3.3a: the
    // catalogue entry is text; the builder writes the <strong> and the anchor around escaped values).
    expect(msg.html).toContain(`<strong>${tenantSlug}</strong>`)
    expect(msg.subject).toBe(inviteSubject('en', tenantSlug, productName()))
    expect(msg.html).toContain(`>${inviteAcceptLabel('en')}</a>`)
  })

  it('the re-issue mail renders Japanese when the tenant default says so (no member row exists yet)', async () => {
    const addr = inviteAddr('reissue')
    const { token } = await createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member' })
    expect(token).toBeTruthy()
    const [row] = await adminPool<{ id: string }[]>`
      SELECT id FROM invites WHERE tenant_id = ${TENANT} AND email = ${addr}`
    // tenant_dev is a shared fixture: capture the prior value, mutate for this one request only, and
    // restore in the finally — the window is one awaited inject, never a whole suite.
    const [prior] = await adminPool<{ default_lang: string | null }[]>`
      SELECT default_lang FROM tenant_settings WHERE tenant_id = ${TENANT}`
    await setDefaultLang('ja')
    try {
      const from = sent.length
      const res = await app.inject({
        method: 'POST', url: `/members/invites/${row!.id}/reissue`,
        headers: AUTH, payload: JSON.stringify({ email: true }),
      })
      expect(res.statusCode).toBe(200)
      const msg = await nextMessage(from)
      expect(msg.to).toBe(addr)
      expect(msg.subject, 'the second step of the chain answers: tenant default').toBe(inviteSubject('ja', tenantSlug, productName()))
      expect(msg.html).toContain(`>${inviteAcceptLabel('ja')}</a>`)
      expect(msg.html, 'no English anchor label on a ja mail').not.toContain(inviteAcceptLabel('en'))
    } finally {
      await setDefaultLang(prior ? prior.default_lang : null)
    }
  })
})
