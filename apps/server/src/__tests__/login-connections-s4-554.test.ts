// #554 S4 / ADR-197 §1-3 + §5: the admin connection-management surface, the per-connection lockout
// guard, and the wc<conn8>_ subject namespacing with its gate flip. The pins that carry weight:
//   - presets: google prefills its issuer; microsoft REQUIRES the Entra tenant GUID and templates
//     the issuer; a preset connection refuses a label (rev3);
//   - label hygiene: bidi-override / control chars / >64 refuse — the string renders on the
//     UNAUTHENTICATED screen;
//   - verify-before-enable per connection (the SSRF-guarded discovery check);
//   - the lockout guard: disabling/deleting the LAST effective connection is 409; with a sibling
//     enabled it passes;
//   - §5 namespacing: a login through a minting connection creates a member whose sub is
//     wc<conn8>_<externalSub>; the SAME external subject through the legacy connection is a
//     SEPARATE raw-sub member (the collision §5 exists to prevent) — and the S0 gates still refuse
//     an externally-asserted wc-prefixed sub (two-faced: reserved-subs-554 holds the refusal face,
//     this file holds the internal-mint face);
//   - break-glass --connection flips one row and ledgers it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { subjectPrefixFor, sanitizeConnectionLabel } from '../routes/admin-connections.js'
import { recoverLoginMethods } from '../scripts/login-methods.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `s4ac-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `s4ac-admin-${STAMP}`
const CLIENT_ID = 'wikistead-s4'
const EXT = `s4-ext-${STAMP}` // the external subject both connections authenticate

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
let sid = ''
let valkey: IORedis
const H = () => ({ host: HOST, cookie: `${SESSION_COOKIE}=${sid}`, 'content-type': 'application/json' })
const HG = () => ({ host: HOST, cookie: `${SESSION_COOKIE}=${sid}` })

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  // the legacy (raw-sub) connection, enabled — the tenant's first way in.
  // #834: it carries a NAME. What makes it "legacy" here is its raw-sub namespacing (§5), not its
  // namelessness, and a nameless row can no longer be edited at all — so leaving it unnamed would
  // make the lockout-guard case below fail on the naming rule instead of reaching the guard. The
  // nameless case is measured on its own row, in the #798/#834 block.
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, label)
    VALUES (${randomUUID()}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 0, true, 'Legacy raw-sub')`
  app = await buildApp()
  await app.ready()
  valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
  sid = await createSession(valkey, { tenantId, sub: ADMIN_SUB, role: 'admin' })
  issuer.setSubject(EXT, { email: 'ext@s4.test' })
}, 60_000)

afterAll(async () => {
  await valkey.quit()
  await app.close()
  await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

const post = (body: object) => app.inject({ method: 'POST', url: '/admin/connections', headers: H(), payload: body })

describe('#554 S4a: connection management', () => {
  it('presets prefill and brand; microsoft needs the Entra GUID; a preset refuses a label (rev3)', async () => {
    const g = await post({ preset: 'google', clientId: 'g', redirectUri: `http://${HOST}/auth/callback` })
    expect(g.statusCode).toBe(201)
    const gid = (g.json() as { id: string }).id
    const [grow] = await admin<{ issuer: string; preset: string; subject_prefix: string }[]>`
      SELECT issuer, preset, subject_prefix FROM tenant_oidc WHERE id = ${gid}`
    expect(grow).toMatchObject({ issuer: 'https://accounts.google.com', preset: 'google', subject_prefix: subjectPrefixFor(gid) })
    expect(grow!.subject_prefix).toMatch(/^wc[0-9a-f]{8}_$/)

    expect((await post({ preset: 'microsoft', clientId: 'm', redirectUri: 'https://x/cb' })).statusCode, 'GUID required').toBe(400)
    const ms = await post({ preset: 'microsoft', clientId: 'm', redirectUri: 'https://x/cb', entraTenantId: '11111111-2222-3333-4444-555555555555' })
    expect(ms.statusCode).toBe(201)
    const [mrow] = await admin<{ issuer: string }[]>`SELECT issuer FROM tenant_oidc WHERE id = ${(ms.json() as { id: string }).id}`
    expect(mrow!.issuer).toBe('https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0')

    expect((await post({ preset: 'google', clientId: 'g', redirectUri: 'https://x/cb', label: 'Evil Corp' })).statusCode, 'preset wears its own branding').toBe(400)
  }, 60_000)

  it('label hygiene: bidi/control/oversize refuse; a clean label lands (preset-less only)', async () => {
    expect(sanitizeConnectionLabel('ok label')).toEqual({ ok: true, label: 'ok label' })
    expect(sanitizeConnectionLabel('x'.repeat(65))).toEqual({ ok: false })
    expect(sanitizeConnectionLabel('a‮b')).toEqual({ ok: false })
    expect(sanitizeConnectionLabel('a\nb')).toEqual({ ok: false })
    const res = await post({ issuer: 'https://idp.example', clientId: 'c', redirectUri: 'https://x/cb', label: ' Corp SSO ' })
    expect(res.statusCode).toBe(201)
    const [row] = await admin<{ label: string }[]>`SELECT label FROM tenant_oidc WHERE id = ${(res.json() as { id: string }).id}`
    expect(row!.label, 'trimmed').toBe('Corp SSO')
    expect((await post({ issuer: 'https://idp.example', clientId: 'c', redirectUri: 'https://x/cb', label: 'bad‮label' })).statusCode).toBe(400)
  }, 60_000)

  // #798 (ruling, 2026-08-21). The sign-in screen calls a nameless connection "single sign-on",
  // which is honest and useless the moment a tenant has two of them — and the admin is the only
  // party who knows the difference, at the moment they add it. So the name is asked for at the
  // write. A preset is the exception in both directions: it wears fixed first-party branding, and a
  // label on one is still refused.
  it('#798: a preset-less connection needs a name, and it cannot be taken away again', async () => {
    const bare = await post({ issuer: 'https://named.example', clientId: 'c', redirectUri: 'https://x/cb' })
    expect(bare.statusCode, bare.body).toBe(400)
    expect(bare.json().code, 'the refusal says which field is missing').toBe('label_required')
    expect((await post({ issuer: 'https://named.example', clientId: 'c', redirectUri: 'https://x/cb', label: '   ' })).statusCode,
      'whitespace is not a name').toBe(400)

    // The control: the same body with a name is created. Without it, a rule that refused every POST
    // would pass the assertions above.
    const ok = await post({ issuer: 'https://named.example', clientId: 'c', redirectUri: 'https://x/cb', label: 'Named SSO' })
    expect(ok.statusCode, ok.body).toBe(201)
    const id = (ok.json() as { id: string }).id

    // …and it cannot be cleared afterwards, which is the same rule at the other end. The editor
    // sends the field on every save of a preset-less row, so a blank one would otherwise be the way
    // back to the state the create refuses.
    const cleared = await app.inject({ method: 'PATCH', url: `/admin/connections/${id}`, headers: H(), payload: { label: '' } })
    expect(cleared.statusCode).toBe(400)
    expect(cleared.json().code).toBe('label_required')
    const [still] = await admin<{ label: string }[]>`SELECT label FROM tenant_oidc WHERE id = ${id}`
    expect(still!.label, 'a refused write left the name alone').toBe('Named SSO')

    // #834 (ruling) removed the exemption that used to live here. A body that merely OMITS the label
    // used to pass, so a row made before the rule stayed manageable — its on/off and MCP switches send
    // no label — until somebody named it. Nobody had such a row (the rule shipped the day it was
    // written), and the exemption cost a second reading of "a connection has a name": true at
    // creation, negotiable afterwards.
    //
    // So the rule is one rule, and this asserts its honest consequence: a nameless preset-less row
    // cannot be edited at all, not even to switch it off, until it is named.
    const legacyId = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, label)
      VALUES (${legacyId}, ${tenantId}, 'https://legacy.example', 'c', NULL, 'openid email profile', '', false, 90, false, NULL)`
    const toggled = await app.inject({ method: 'PATCH', url: `/admin/connections/${legacyId}`, headers: H(), payload: { mcpEnabled: true } })
    expect(toggled.statusCode, toggled.body).toBe(400)
    expect(toggled.json().code).toBe('label_required')
    // …and naming it in the same breath is what unblocks it.
    const named = await app.inject({ method: 'PATCH', url: `/admin/connections/${legacyId}`, headers: H(), payload: { mcpEnabled: true, label: 'Legacy SSO' } })
    expect(named.statusCode, named.body).toBe(204)
    await admin`DELETE FROM tenant_oidc WHERE id = ${legacyId}`

    // A preset still refuses one, and still needs none.
    const g = await post({ preset: 'google', clientId: 'g2', redirectUri: 'https://x/cb' })
    expect(g.statusCode, 'a preset carries its own name').toBe(201)
  }, 60_000)

  it('verify-before-enable: enabling against an unreachable/refused issuer is 400', async () => {
    const res = await post({ issuer: 'http://127.0.0.1:1/', clientId: 'c', redirectUri: 'https://x/cb', label: 'Unreachable', enabled: true })
    expect(res.statusCode).toBe(400)
  }, 60_000)

  it('the lockout guard: the LAST effective connection refuses disable and delete; a sibling unlocks it', async () => {
    const [first] = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId} AND enabled ORDER BY sort, id LIMIT 1`
    const off = await app.inject({ method: 'PATCH', url: `/admin/connections/${first!.id}`, headers: H(), payload: { enabled: false } })
    expect(off.statusCode, 'last way in — refused').toBe(409)
    const del = await app.inject({ method: 'DELETE', url: `/admin/connections/${first!.id}`, headers: HG() })
    expect(del.statusCode).toBe(409)

    const sibling = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
      VALUES (${sibling}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, 'openid', ${`http://${HOST}/auth/callback`}, true, 5, ${subjectPrefixFor(sibling)})`
    try {
      // ⚠️ ADR-251 / #822 changed what "unlocked" means here. A sibling connection is a door, but the
      // product cannot promise anybody can walk through a federated door, so one remaining door with
      // no key behind it is the ruling's confirm case, not a silent yes. The guard still refuses the
      // write that leaves NOTHING (above); this one asks, and takes the answer.
      const asks = await app.inject({ method: 'PATCH', url: `/admin/connections/${first!.id}`, headers: H(), payload: { enabled: false } })
      expect(asks.statusCode, 'a lone unverifiable door went through unasked').toBe(409)
      expect(asks.json().code).toBe('confirm_required')
      const offNow = await app.inject({ method: 'PATCH', url: `/admin/connections/${first!.id}`, headers: H(), payload: { enabled: false, confirm: true } })
      expect(offNow.statusCode, 'a live sibling unlocks the guard once confirmed').toBe(204)
      // re-enable via SQL: the PATCH path would run discovery against the LOCAL test issuer, which
      // the hardened fetch refuses by design (the verify gate is pinned separately above)
      await admin`UPDATE tenant_oidc SET enabled = true WHERE id = ${first!.id}`
    } finally {
      await admin`DELETE FROM tenant_oidc WHERE id = ${sibling}`
    }
  }, 60_000)

  it('break-glass --connection flips one row and ledgers the act', async () => {
    const target = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
      VALUES (${target}, ${tenantId}, 'https://idp.example', 'c', 'openid', 'https://x/cb', true, 6, ${subjectPrefixFor(target)})`
    try {
      const r = await recoverLoginMethods(admin, { slug: SLUG, operator: 's4-test', connection: { id: target, on: false } })
      expect(r.changed).toBe(true)
      const [row] = await admin<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc WHERE id = ${target}`
      expect(row!.enabled).toBe(false)
      const ledger = await admin<{ action: string }[]>`
        SELECT action FROM operator_audit_log WHERE actor = 'operator:s4-test' AND target = ${`tenant:${tenantId}`}`
      expect(ledger.some((l) => l.action === 'tenant.connection_disabled')).toBe(true)
    } finally {
      await admin`DELETE FROM tenant_oidc WHERE id = ${target}`
    }
  }, 60_000)
})

describe('#554 S4b: subject namespacing (§5) — the internal-mint face', () => {
  it('a minting connection creates wc<conn8>_<ext>; the legacy connection keeps the raw sub — TWO members, no merge', async () => {
    const minting = randomUUID()
    const prefix = subjectPrefixFor(minting)
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
      VALUES (${minting}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 7, ${prefix})`
    const tuples = [
      { user: `user:${prefix}${EXT}`, relation: 'member', object: `tenant:${tenantId}` },
      { user: `user:${EXT}`, relation: 'member', object: `tenant:${tenantId}` },
    ]
    await writeTuples(fgaClient, tuples)
    try {
      const login = async (connection: string) => {
        const res = await app.inject({ method: 'GET', url: `/auth/login?connection=${connection}`, headers: { host: HOST } })
        expect(res.statusCode).toBe(302)
        const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
        const u = new URL(authRes.headers.get('location')!)
        const cb = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
        expect(cb.statusCode).toBe(302)
        expect(String(cb.headers['set-cookie'] ?? ''), 'session established').toContain(`${SESSION_COOKIE}=`)
      }
      await login(minting)
      const [namespaced] = await admin<{ sub: string }[]>`
        SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub = ${prefix + EXT}`
      expect(namespaced, 'the namespaced identity exists — the gate flip admitted OUR mint').toBeDefined()

      const [legacy] = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId} AND subject_prefix IS NULL ORDER BY sort, id LIMIT 1`
      await login(legacy!.id)
      const rows = await admin<{ sub: string }[]>`
        SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub IN (${EXT}, ${prefix + EXT}) ORDER BY sub`
      expect(rows.map((r) => r.sub).sort(), 'two members — the §5 collision never happens').toEqual([EXT, prefix + EXT].sort())
    } finally {
      await deleteTuples(fgaClient, tuples).catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenantId} AND sub IN (${EXT}, ${prefix + EXT})`.catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${minting}`
    }
  }, 60_000)
})

// #554 S4 re-review F6 (the ADR §5 rev3 anti-test mandate, spoof face THROUGH the minting path)
// + F7 (authority and cross-tenant pins for the admin surface) + F1 (issuer shape at write).
describe('#554 S4 re-review pins', () => {
  it('F6: a reserved RAW subject through a MINTING connection is refused pre-mint — even as a member both ways', async () => {
    const minting = randomUUID()
    const prefix = subjectPrefixFor(minting)
    const RESERVED_RAW = `wcdeadbeef_spoof-${STAMP}`
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
      VALUES (${minting}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 8, ${prefix})`
    const tuples = [
      { user: `user:${RESERVED_RAW}`, relation: 'member', object: `tenant:${tenantId}` },
      { user: `user:${prefix}${RESERVED_RAW}`, relation: 'member', object: `tenant:${tenantId}` },
    ]
    await writeTuples(fgaClient, tuples)
    issuer.setSubject(RESERVED_RAW, { email: 'spoof@s4.test' })
    try {
      const res = await app.inject({ method: 'GET', url: `/auth/login?connection=${minting}`, headers: { host: HOST } })
      expect(res.statusCode).toBe(302)
      const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
      const u = new URL(authRes.headers.get('location')!)
      const cb = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
      expect(cb.statusCode).toBe(302)
      expect(String(cb.headers.location), 'refused BEFORE the mint, vague').toContain('/login?error=access')
      expect(String(cb.headers['set-cookie'] ?? '')).not.toContain(`${SESSION_COOKIE}=`)
      expect((await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub LIKE ${'%' + RESERVED_RAW}`).length,
        'no row under either identity').toBe(0)
    } finally {
      await deleteTuples(fgaClient, tuples).catch(() => {})
      await admin`DELETE FROM tenant_oidc WHERE id = ${minting}`
    }
  }, 60_000)

  it('F7: every route is tenant-admin gated (plain member → 403) and RLS-scoped (foreign id → 404/no-op)', async () => {
    const PLAIN = `s4-plain-${STAMP}`
    await writeTuples(fgaClient, [{ user: `user:${PLAIN}`, relation: 'member', object: `tenant:${tenantId}` }])
    const plainSid = await createSession(valkey, { tenantId, sub: PLAIN, role: 'member' })
    const HP = { host: HOST, cookie: `${SESSION_COOKIE}=${plainSid}`, 'content-type': 'application/json' }
    try {
      expect((await app.inject({ method: 'GET', url: '/admin/connections', headers: HP })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/admin/connections', headers: HP, payload: { issuer: 'https://x', clientId: 'c', redirectUri: 'https://x/cb' } })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/admin/connections/reorder', headers: HP, payload: { ids: ['x'] } })).statusCode).toBe(403)

      // a foreign tenant's connection id: invisible through RLS
      const foreign = randomUUID()
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${foreign}, ${`s4f-${STAMP}`}, 'business', 'logical')`
      const foreignConn = randomUUID()
      await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
        VALUES (${foreignConn}, ${foreign}, 'https://idp.example', 'c', 'openid', 'https://x/cb', true, 0, ${subjectPrefixFor(foreignConn)})`
      try {
        expect((await app.inject({ method: 'PATCH', url: `/admin/connections/${foreignConn}`, headers: H(), payload: { enabled: false } })).statusCode).toBe(404)
        expect((await app.inject({ method: 'DELETE', url: `/admin/connections/${foreignConn}`, headers: HG() })).statusCode).toBe(404)
        const [still] = await admin<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc WHERE id = ${foreignConn}`
        expect(still!.enabled, 'untouched across the tenant boundary').toBe(true)
      } finally {
        await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${foreign}`
        await admin`DELETE FROM tenants WHERE id = ${foreign}`
      }
    } finally {
      await deleteTuples(fgaClient, [{ user: `user:${PLAIN}`, relation: 'member', object: `tenant:${tenantId}` }]).catch(() => {})
    }
  }, 60_000)

  it('F1: a non-URL issuer refuses at WRITE time, enabled or not', async () => {
    expect((await post({ issuer: 'not a url', clientId: 'c', redirectUri: 'https://x/cb', label: 'Shapeless' })).statusCode).toBe(400)
    expect((await post({ issuer: 'idp.example.com', clientId: 'c', redirectUri: 'https://x/cb', label: 'Schemeless' })).statusCode, 'scheme-less refuses too').toBe(400)
  }, 60_000)
})
