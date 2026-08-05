// #554 / ADR-197 §5 (S0): the reserved internal sub space, enforced at every seam where an
// externally-asserted subject becomes a principal. Each seam refuses with ITS OWN failure shape
// (never a distinguishable oracle); internal read-backs are untouched. The SCIM seam (the most
// direct vector — the client chooses the sub) is pinned on the EE side (managed there); the OIDC
// bearer seam cannot be driven end-to-end without a live IdP, so it carries a lexical pin here plus
// the shared validator's unit pins — stated honestly, not padded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { externalSubViolation, mintMcpAccessToken } from './helpers/reserved-subs-helper.js'
import { establishMemberSession } from '../auth/session.js'
import { acceptInvite, createInvite } from '../auth/invites.js'
import { provisionTenant } from '../auth/provisioning.js'
import { buildApp } from '../app.js'
import IORedis from 'ioredis'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)

const RESERVED = [`wc00000000_intruder-${STAMP}`, `wlocal_${STAMP}`]
const TOO_LONG = 'x'.repeat(502)

let app: FastifyInstance
let db: TenantDb
let valkey: IORedis

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
}, 60_000)

afterAll(async () => {
  await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email LIKE ${'rs554%'}`.catch(() => {})
  await db.release(); await valkey.quit(); await app.close(); await adminPool.end(); await pool.end()
}, 60_000)

describe('#554 S0: the reserved sub space', () => {
  it('validator: reserved prefixes, the FGA length cap and the rest of the grammar; ordinary subs pass', () => {
    for (const s of [...RESERVED, 'wlocal_']) expect(externalSubViolation(s), s).toBe('reserved')
    expect(externalSubViolation(TOO_LONG)).toBe('too-long')
    // S0 re-verification: the FGA constraint is BYTES on the whole user string (id budget 507,
    // minus the 11-byte prefix = 496) — and it is bytes, not UTF-16 code units, so a short-looking
    // multi-byte sub must be refused too (this was measured fail-open before the byte fix).
    expect(externalSubViolation('x'.repeat(496)), 'exactly 496 fits under the prefix budget').toBeNull()
    expect(externalSubViolation('x'.repeat(497)), '497 ASCII bytes bursts it').toBe('too-long')
    expect(externalSubViolation('あ'.repeat(200)), '200 chars / 600 UTF-8 bytes').toBe('too-long')
    // S0 review concern 4: whitespace fails at the seam, not deep inside FGA; empty is our own
    // non-empty restriction. A 1-character sub is measured-VALID at FGA and passes.
    for (const bad of ['', 'has space', 'tab\tsub', 'nl\nsub']) {
      expect(externalSubViolation(bad), JSON.stringify(bad)).toBe('malformed')
    }
    for (const ok of ['a', 'alice', 'wc123_x' /* 3 hex, not 8 */, 'WC00000000_x' /* mint grammar is lowercase */, 'oauth2|google-oauth2|1234']) {
      expect(externalSubViolation(ok), ok).toBeNull()
    }
  })

  // RE-AIMED by #592 / ADR-204 (OQ2). This counted reserved-prefix rows across the whole `members`
  // table and read the count as "the exemption is not a standing bypass". It passed only because the
  // one suite that creates a namespaced member deletes it in a `finally`: in a real database a single
  // legitimate login through a namespacing connection turns it red, and a legitimate login is not a
  // breach. The proposition worth pinning was never the row count — it is that no reserved sub gets
  // in through an EXTERNAL assertion, which is proved by driving the external seam rather than by
  // counting. (The seam-1 pin below drives the login upsert itself; this one states the invariant on
  // the table afterwards, scoped to the subs THIS suite asserted.)
  it('no reserved sub enters members through an external assertion', async () => {
    const claimed = await adminPool<{ sub: string }[]>`
      SELECT sub FROM members WHERE tenant_id = ${TENANT} AND sub = ANY(${[...RESERVED, TOO_LONG]})`
    expect(claimed, 'every seam that turns an outside claim into a member row refused these').toEqual([])
  })

  // Non-vacuous by construction (S0 review 2): the reserved sub IS made a tenant member
  // first, so with the gate deleted the login SUCCEEDS (upserts a row, opens a session) — the
  // membership refusal can no longer masquerade as the gate.
  it('seam 1 — login upsert: a reserved sub is a 403 shaped exactly like a non-member, even AS a member', async () => {
    const member = [...RESERVED, TOO_LONG].map((sub) => ({ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }))
    const { writeTuples, deleteTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, member)
    try {
      for (const sub of [...RESERVED, TOO_LONG]) {
        await expect(establishMemberSession({ db, fga: fgaClient, valkey }, { id: TENANT, plan: 'business' }, { sub }))
          .rejects.toMatchObject({ statusCode: 403, message: 'not a member of this tenant' })
        expect((await adminPool<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND sub = ${sub}`).length,
          'refused BEFORE the row upsert').toBe(0)
      }
    } finally {
      await deleteTuples(fgaClient, member).catch(() => {})
    }
  }, 60_000)

  it('seam 2 — invite acceptance: a reserved sub answers false (an unknown-invite shape), the invite stays pending', async () => {
    const { token } = await createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: `rs554-${STAMP}@t.test`, role: 'member' })
    expect(await acceptInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, { sub: RESERVED[0]! })).toBe(false)
    const [inv] = await adminPool<{ status: string }[]>`SELECT status FROM invites WHERE tenant_id = ${TENANT} AND email = ${`rs554-${STAMP}@t.test`}`
    expect(inv!.status, 'not consumed').toBe('pending')
  }, 60_000)

  it('seam 3 — Cloud provisioning: a reserved admin sub is a 400 like any bad signup input', async () => {
    await expect(provisionTenant(fgaClient, { slug: `rs554-${STAMP}`, admin: { sub: RESERVED[1]! } }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect((await adminPool<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${`rs554-${STAMP}`}`).length, 'no tenant seated').toBe(0)
  }, 60_000)

  it('seam 4 — CE first-admin bootstrap: a reserved sub never becomes the first admin (false, no row)', async () => {
    // bootstrap only fires on a member-less tenant; on tenant_dev (members exist) it answers false
    // for everyone — so drive the guard's ORDER: it must refuse BEFORE the member-count decision.
    // RETIRED BY NAME (#616 / ADR-212 slice 2): the case used to prove that `bootstrapFirstAdmin`
    // refused a reserved sub. That entrance is gone, and the same guard is measured where the
    // surviving one lives — `provisionTenant` calls `assertExternalSub` unconditionally, which is the
    // reason slice 1's operator command cannot take a sub at all.
    const slug = `rs554b-${STAMP}`
    await expect(
      provisionTenant(fgaClient, { slug, admin: { sub: RESERVED[0]! } }),
      'a reserved-prefix sub never seats an admin through the surviving entrance either',
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(
      (await adminPool`SELECT id FROM tenants WHERE slug = ${slug}`).length,
      'and no tenant is left behind by the refusal',
    ).toBe(0)
  }, 60_000)

  // RE-AIMED by #592 / ADR-204. This asserted that a reserved-prefix sub is 401 at the MCP entry "even
  // AS a member" — and the identity it called an intruder is the exact shape a legitimate namespaced
  // member carries (#570 stamps `wc<conn8>_` on every connection it creates). The pin was green for the
  // right mechanical reason and wrong about who it was describing; the flip makes membership the
  // authority here, so the pair below replaces it. Its two faces live in mcp-connection-gate-592, with
  // the whole OAuth chain rather than a hand-minted token.
  it('seam 7 — MCP broker: a reserved-prefix sub that is NOT a member is still refused', async () => {
    // The half that must not move: dropping the prefix check did not make the entry admit strangers.
    const token = await mintMcpAccessToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
      { tenantId: TENANT, sub: RESERVED[0]!, scopes: ['read'], groups: [] },
    )
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { host: 'dev.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(res.statusCode, 'membership is what admits, and this sub has none').toBe(401)
  }, 60_000)

  it('seam 5b — the EE auth-provider extension point: one gate covers every provider (S0 review 懸念 3)', async () => {
    const { registerAuthProvider, resetAuthProviders } = await import('@wikistead/hooks')
    const { writeTuples, deleteTuples } = await import('@wikistead/authz')
    const tuple = [{ user: `user:${RESERVED[0]!}`, relation: 'member', object: `tenant:${TENANT}` }]
    await writeTuples(fgaClient, tuple)
    registerAuthProvider({ name: 'rs554-dummy', verify: async (token) => (token === 'rs554-vouched' ? { sub: RESERVED[0]!, groups: [] } : null) })
    try {
      const res = await app.inject({
        method: 'GET', url: '/me/capabilities',
        headers: { host: 'dev.localhost', authorization: 'Bearer rs554-vouched' },
      })
      expect(res.statusCode, 'a provider cannot vouch a reserved sub in, membership or not').toBe(401)
    } finally {
      resetAuthProviders()
      await deleteTuples(fgaClient, tuple).catch(() => {})
    }
  }, 60_000)

  it('seam 6 — OIDC bearer (lexical: no live IdP to drive it end-to-end): the violation check guards req.user', () => {
    const src = readFileSync(new URL('../app.ts', import.meta.url), 'utf8')
    const bearer = src.slice(src.indexOf('OIDC bearer path'), src.indexOf('claimedTenant = m.tenantId'))
    expect(bearer, 'the check sits between verifyMember and the principal assignment').toContain('externalSubViolation')
    expect(bearer.indexOf('externalSubViolation'), 'before req.user').toBeLessThan(bearer.indexOf('req.user = { sub: m.sub'))
  })
})
