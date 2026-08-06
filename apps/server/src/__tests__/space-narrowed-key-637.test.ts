import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { pool } from '../db/pool.js'
import { registerNarrowedKeyGate, resetNarrowedKeyGate } from '@wikistead/hooks'
import { registerAuthzRestrictionEvaluator, resetAuthzRestrictionEvaluator, fgaClient } from '@wikistead/authz'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'

// #637 / ADR-216: a key confined to a SPACE, from the request path's side.
//
// This is the defect the ADR put first. Narrowing's whole apparatus — the refusal on credential-minting
// routes, the route table — hung off a truthiness test on `capabilities`, which answers "not narrowed"
// about a key confined only by space. And `POST /auth/collab-token` mints a token carrying the OWNER's
// identity, which the live-editing process honours in full with no knowledge of API keys. One space in,
// every space out.
//
// Rows are minted directly: issuing such a key is the EE half, and the question here is what the request
// path does when one ARRIVES — which is the half that has to hold whether or not the overlay is present.
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)

let app: FastifyInstance
// The listing fixture is this spec's own. Pointing it at `demo_space` passed alone and failed in a full
// run — other suites create and delete pages in the shared tenant, so "the space has pages to lose" is a
// claim about somebody else's state.
const driver = new LogicalSearchDriver()
let db: TenantDb
let mySpace: string
let myPage: string

async function mintKey(name: string, opts: { capabilities?: string[] | null; spaces?: string[] | null }): Promise<string> {
  const prefix = randomBytes(6).toString('base64url')
  const plaintext = `wks_${prefix}_${randomBytes(24).toString('base64url')}`
  await admin`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope, capabilities, space_ids)
    VALUES (${T}, ${OWNER}, ${`spc637-${name}-${STAMP}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(plaintext).digest('hex')}, 'write',
            ${opts.capabilities ?? null}, ${opts.spaces ?? null})`
  return plaintext
}

// `content-type: application/json` only when there IS a body: a bodyless POST carrying it is rejected by
// Fastify with FST_ERR_CTP_EMPTY_JSON_BODY, which is a 400 that looks like the route said no.
const call = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: { host: 'dev.localhost', authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  const tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  mySpace = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OWNER, plan: tenant.plan, name: `spc637-${STAMP}` })).id
  myPage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: mySpace, userId: OWNER, title: 'confined listing' })).id
}, 180_000)
afterEach(() => { resetNarrowedKeyGate(); resetAuthzRestrictionEvaluator() })
afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${'spc637-%'}`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: myPage, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: T, spaceId: mySpace, userId: OWNER }).catch(() => {})
  await db.release()
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('#637: a key confined to a space cannot mint a credential that is not', () => {
  it('POST /auth/collab-token is refused — the escalation the ADR was written for', async () => {
    // The token this route mints carries the OWNER's sub. Collab re-derives authority from OpenFGA for
    // that subject, so a space-confined key holding one would be editing live in every space there is.
    registerNarrowedKeyGate(() => true) // the route table would allow it; the minting rule outranks that
    const key = await mintKey('collab', { spaces: ['demo_space'] })
    const res = await call(key, 'POST', '/auth/collab-token')
    expect(res.statusCode, 'confined by space is narrowed, and a narrowed key mints nothing').toBe(403)
    expect(res.json().code).toBe('narrowed_key')
  }, 60_000)

  it('…and so are the other credential-minting routes', async () => {
    registerNarrowedKeyGate(() => true)
    const key = await mintKey('mint', { spaces: ['demo_space'] })
    for (const url of ['/api-keys', '/share-links']) {
      const res = await call(key, 'POST', url, {})
      expect(res.statusCode, `${url} refuses a space-confined key`).toBe(403)
      expect(res.json().code).toBe('narrowed_key')
    }
  }, 60_000)

  it('an unconfined key still mints, so the refusal is the confinement talking', async () => {
    const key = await mintKey('plain', {})
    const res = await call(key, 'POST', '/auth/collab-token')
    expect(res.statusCode, 'nothing confines this one').toBe(200)
    expect(res.json().token, 'and it really is a token').toBeTruthy()
  }, 60_000)

  it('the route table is asked with the confinement, not without it', async () => {
    // The gate's input carries `spaces` now. A table that grows a space dimension next needs to see it,
    // and a request shape that dropped it would make every such rule silently unenforceable.
    const seen: { spaces?: ReadonlySet<string> | null }[] = []
    registerNarrowedKeyGate((req) => { seen.push({ spaces: req.spaces }); return true })
    const key = await mintKey('gate', { spaces: ['demo_space'] })
    await call(key, 'GET', '/spaces')
    expect(seen.length, 'the gate was consulted').toBeGreaterThan(0)
    expect([...(seen[0]!.spaces ?? [])], 'and it was told what the key is confined to').toEqual(['demo_space'])
  }, 60_000)
})

describe('#637: the confinement reaches the primitives, through the request', () => {
  /**
   * A stand-in rule, and it is one deliberately: CE may not import the EE package (`lint:no-ee-imports`),
   * so what this file can measure is the SEAM — that a restriction set during authentication reaches the
   * primitives and narrows what a request sees.
   *
   * It is not evidence about the shipped rule, and saying so is the point. The review found the
   * real evaluator resolving every page to "unresolvable" — it read `pages` on the pooled connection with
   * no tenant in the session, so row-level security returned nothing — while this file stayed green,
   * because this stand-in reads over the admin connection instead. One different line, and it was the
   * broken one. The rule the product registers is exercised in
   * `packages/ee-server/src/__tests__/space-restriction-shipped-637.test.ts`, against a real request.
   *
   * Kept reading over `admin` on purpose: this stand-in has no scope resolver to consult and inventing
   * one here would make the file look like it were testing the real thing again.
   */
  const registerSpaceRule = () => registerAuthzRestrictionEvaluator(async (restriction, resource) => {
    if (resource.type === 'space') return restriction.spaces.has(resource.id) ? 'allow' : 'deny'
    if (resource.type !== 'page') return 'allow'
    const [row] = await admin<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${resource.id}`
    if (!row) return 'unresolvable'
    return restriction.spaces.has(row.space_id) ? 'allow' : 'deny'
  })

  const pageCount = async (key: string) => {
    const res = await call(key, 'GET', `/spaces/${mySpace}/pages`)
    expect(res.statusCode, 'the listing answered').toBeLessThan(400)
    const body = res.json()
    return (Array.isArray(body) ? body : (body.pages ?? body.items ?? [])).length as number
  }

  it('the listing is confined, and the unconfined control proves the space has pages at all', async () => {
    // Measured at the CONTENTS, not the status. This route has no space-level gate — it lists what the
    // subject may view — so a confinement shows up as an empty list, and a status assertion here would
    // have been green against an implementation that did nothing.
    registerNarrowedKeyGate(() => true)
    registerSpaceRule()
    expect(await pageCount(await mintKey('plain2', {})), 'the space has pages to lose').toBeGreaterThan(0)
    expect(await pageCount(await mintKey('reach-in', { spaces: [mySpace] })), 'confined to this space')
      .toBeGreaterThan(0)
    expect(await pageCount(await mintKey('reach-out', { spaces: ['some-other-space'] })),
      'confined elsewhere: the scope carried it all the way into filterAuthorized').toBe(0)
  }, 60_000)

  it('with no evaluator registered, a confined key reaches nothing', async () => {
    // What a deployment looks like with the EE overlay removed. The key must not widen back.
    registerNarrowedKeyGate(() => true)
    expect(await pageCount(await mintKey('noeval', { spaces: [mySpace] })),
      'no rule to interpret it means the restriction stands').toBe(0)
  }, 60_000)
})
