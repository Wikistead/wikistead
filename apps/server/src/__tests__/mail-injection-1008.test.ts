// #1008 review bounce: the escapes that commit ebeff920 introduced had no regression
// pin. #1056 replaced the underlying hole those escapes were papering over — the reset link and the
// invite mail were built from `req.headers.host`, so a spoofed Host moved the link's ORIGIN, not just
// its markup (a userinfo-form Host even let `new URL()` rewrite the origin outright, past every `esc`
// call #1008 added). The three request-path sends (reset, invite create, invite re-issue) now build
// their link from `tenantBaseUrl()` — the deployment's own declared address — and this file holds
// THAT boundary: a hostile Host has no effect on where the link points, and a deployment with no
// declared address degrades honestly (no link sent) instead of trusting the request to supply one.
//
// The Japanese-rendering assertions carried over from the original file stay: the catalogue being
// bilingual is pinned elsewhere, but a builder that never consulted it would still pass a pin that
// only checked English, so each send is measured in both languages at least once across the suite.
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

// The payload rides BEHIND the colon: `split(':')[0]` still resolves tenant_dev, and (before #1056)
// the raw header — payload included — was what the route interpolated into `<a href="...">`. Kept as
// the attack input because it is still a real Host a client can send; what changed is that the route
// no longer reads `req.headers.host` for the link at all, so this input now proves a NEGATIVE.
const HOSTILE_HOST = 'dev.localhost:80"><script>alert(1)</script>'
const RAW_MARKER = '"><script>'

// The deployment's declared address for these tests (.env.server-test). tenantBaseUrl() prefixes the
// tenant's slug onto its host, so 'dev' composes to this exact origin — never the HOSTILE_HOST above.
const CONFIGURED_ORIGIN = 'http://dev.localhost:5173'

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

// A window where NO message arrives is itself the assertion (the "no address configured" cases) —
// polling for an ABSENCE needs its own helper, not a shorter timeout on the presence one above (a
// short timeout there would make a slow-but-real send look like a correctly-suppressed one).
async function noMessageArrives(from: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 300))
  expect(sent.length, 'no message was sent while unaddressed').toBe(from)
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

describe('#1056: mail links ignore a hostile Host and land on the configured address', () => {
  it('the reset mail lands on the configured origin, never the hostile Host', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/auth/local/reset-request',
      headers: { host: HOSTILE_HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: JSON.stringify({ identifier: localAddr }),
    })
    expect(res.statusCode, 'the uniform answer').toBe(204)
    const msg = await nextMessage(from)
    expect(msg.to).toBe(localAddr)
    // The boundary itself: the hostile fragment reaches the route (it is a valid Host header) but
    // never reaches the link, because the link is no longer built from the Host at all.
    expect(msg.html, 'the hostile Host never lands anywhere in the message').not.toContain(RAW_MARKER)
    expect(msg.text, 'not even in the text part').not.toContain(RAW_MARKER)
    expect(msg.html, 'the link lands on the configured origin').toContain(`href="${CONFIGURED_ORIGIN}/reset-password?token=`)
    expect(msg.text, 'and so does the text-part copy of it').toContain(`${CONFIGURED_ORIGIN}/reset-password?token=`)
    // The Japanese face of THIS mail (the catalogue's own en≠ja is pinned elsewhere; this asserts
    // the builder consults it): subject and anchor label are the ja entries, not the en ones.
    expect(msg.subject).toBe(resetSubject('ja', productName()))
    expect(msg.html).toContain(resetLinkLabel('ja'))
    expect(msg.html, 'no English anchor label on a ja mail').not.toContain(resetLinkLabel('en'))
  })

  it('the invite-create mail and response both land on the configured origin', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/members/invites',
      headers: { ...AUTH, host: HOSTILE_HOST },
      payload: JSON.stringify({ email: inviteAddr('create'), role: 'member' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { inviteUrl: string | null; emailed: boolean }
    expect(body.emailed, 'the route reports the send').toBe(true)
    expect(body.inviteUrl, 'the response carries the configured origin too').toMatch(new RegExp(`^${CONFIGURED_ORIGIN}/invite\\?token=`))
    const msg = await nextMessage(from)
    expect(msg.to).toBe(inviteAddr('create'))
    expect(msg.html, 'the hostile Host never lands anywhere in the message').not.toContain(RAW_MARKER)
    expect(msg.html).toContain(`href="${CONFIGURED_ORIGIN}/invite?token=`)
    // The slug and product name still pass through esc and land inside builder-owned tags (§3.3a:
    // the catalogue entry is text; the builder writes the <strong> and the anchor around them).
    expect(msg.html).toContain(`<strong>${tenantSlug}</strong>`)
    expect(msg.subject).toBe(inviteSubject('en', tenantSlug, productName()))
    expect(msg.html).toContain(`>${inviteAcceptLabel('en')}</a>`)
  })

  it('the re-issue mail lands on the configured origin and renders Japanese when the tenant default says so', async () => {
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
        headers: { ...AUTH, host: HOSTILE_HOST }, payload: JSON.stringify({ email: true }),
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { inviteUrl: string | null }
      expect(body.inviteUrl).toMatch(new RegExp(`^${CONFIGURED_ORIGIN}/invite\\?token=`))
      const msg = await nextMessage(from)
      expect(msg.to).toBe(addr)
      expect(msg.html, 'the hostile Host never lands anywhere in the message').not.toContain(RAW_MARKER)
      expect(msg.html).toContain(`href="${CONFIGURED_ORIGIN}/invite?token=`)
      expect(msg.subject, 'the second step of the chain answers: tenant default').toBe(inviteSubject('ja', tenantSlug, productName()))
      expect(msg.html).toContain(`>${inviteAcceptLabel('ja')}</a>`)
      expect(msg.html, 'no English anchor label on a ja mail').not.toContain(inviteAcceptLabel('en'))
    } finally {
      await setDefaultLang(prior ? prior.default_lang : null)
    }
  })
})

describe('#1056: an unaddressed deployment degrades honestly instead of trusting the request', () => {
  // tenant_dev carries no verified custom_domains row by default (infra/db/seed.ts only inserts one
  // when DEV_CUSTOM_DOMAIN is set, which .env.server-test does not set) — clearing the env var alone
  // is enough to put tenantBaseUrl() into its null branch for the whole describe block.
  let prior: string | undefined
  beforeAll(() => { prior = process.env.WKS_PUBLIC_BASE_URL; delete process.env.WKS_PUBLIC_BASE_URL })
  afterAll(() => { if (prior !== undefined) process.env.WKS_PUBLIC_BASE_URL = prior })

  it('reset-request stays the same uniform 204, and sends nothing', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/auth/local/reset-request',
      headers: { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: JSON.stringify({ identifier: localAddr }),
    })
    expect(res.statusCode, 'still uniform — the caller learns nothing').toBe(204)
    await noMessageArrives(from)
  })

  it('invite create still creates the invite, but reports no link and sends nothing', async () => {
    const from = sent.length
    const res = await app.inject({
      method: 'POST', url: '/members/invites',
      headers: AUTH, payload: JSON.stringify({ email: inviteAddr('unaddressed'), role: 'member' }),
    })
    expect(res.statusCode, 'the invite itself is not refused — only the link is unavailable').toBe(201)
    const body = res.json() as { inviteUrl: string | null; emailed: boolean }
    expect(body.inviteUrl, 'nothing to build a link from').toBeNull()
    expect(body.emailed, 'nothing to email either').toBe(false)
    await noMessageArrives(from)
  })
})
