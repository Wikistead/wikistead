// #874 / ADR-248 §3.4, §3.6, §3.7, §3.10: the guest token refresh, server side.
//
// A guest token lives 300 seconds; collab authenticates once, at connect; every guest HTTP call carries
// the same token as its bearer. A session that outlives one token therefore has to be able to produce
// the next one, and the whole difficulty is that it must do so WITHOUT becoming a way around anything:
// not the pseudonym (which is the attribution key), not the abuse budgets keyed on it, not the link's
// revocation, not a password link's door, and not the funnel's denominator.
//
// ⚠️ Why this is a server-suite walk and not an e2e one. The acceptance in §6 names the trap: the TTL is
// read from the environment and the e2e stack runs ONE server process for every spec, so a short TTL
// there puts every other guest walk on a three-second credential — and a short-lived LINK cannot stand in
// for it, because the mint clamps the token's TTL to the link's remaining life, so the two die together
// and a refusal to refresh proves nothing about the refresh. Here the token is minted directly with the
// `ses` and `exp` each case needs, which is the one place the session's age can be set without moving a
// process-wide value. The browser-side seam (#875) is where the surviving cursor is measured.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { decodeJwt, SignJWT } from 'jose'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { GUEST_SESSION_CEILING_SECONDS } from '../routes/share-links.js'
import { registerFunnelCollector, resetFunnelCollector } from '../funnel/sink.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let spaceId: string
const createdPages: string[] = []

const resetCaps = () => admin`
  UPDATE tenant_settings SET abuse_create_page_link_max = NULL, abuse_create_page_session_max = NULL
  WHERE tenant_id = ${TENANT}`

async function mkLink(capability: 'view' | 'edit', password?: string): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/share-links', headers: dev,
    payload: { resource: { type: 'space', id: spaceId }, capability, expiresInSeconds: null, ...(password ? { password } : {}) },
  })
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as { id: string }).id
}

/** A token exactly as some earlier moment would have minted it — the only way to set a session's age. */
const mkTok = (linkId: string, opts: { capability?: 'view' | 'edit'; anonId?: string; ses?: number; ttlSeconds?: number } = {}) =>
  mintGuestToken(
    { secret: guestCfg.secret, ttlSeconds: opts.ttlSeconds ?? 300 },
    { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'space', id: spaceId }, capability: opts.capability ?? 'edit', ...(opts.anonId ? { anonId: opts.anonId } : {}), ...(opts.ses ? { ses: opts.ses } : {}) },
  )

const claimsOf = (token: string) => decodeJwt(token) as unknown as { anonId?: string; ses?: number; capability: string }

const refresh = (linkId: string, token: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST', url: `/public/share-links/${linkId}/token/refresh`,
    headers: { host: 'dev.localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload,
  })

const exchange = (linkId: string, opts: { token?: string; payload?: Record<string, unknown> } = {}) =>
  app.inject({
    method: 'POST', url: `/public/share-links/${linkId}/token`,
    headers: { host: 'dev.localhost', 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    payload: opts.payload ?? {},
  })

const createAsGuest = (token: string, title: string) =>
  app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { title } })

const now = () => Math.floor(Date.now() / 1000)
let seq = 0
const anon = () => `anon:${(Date.now() + seq++).toString(16).slice(-12).padStart(12, '0')}`

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${TENANT}) ON CONFLICT (tenant_id) DO NOTHING`
  await resetCaps()
  db = await acquireTenantDb({ id: TENANT, slug: 'dev', plan: 'free', isolation: 'logical' } as never)
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `gtr874-${Date.now().toString(36)}` })).id
}, 120_000)

afterEach(async () => {
  await resetCaps()
  resetFunnelCollector()
})

afterAll(async () => {
  await app.close()
  for (const id of createdPages) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteObjectTuples(fgaClient, `space:${spaceId}`).catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 120_000)

describe('#874 the session continues, and nothing else does', () => {
  it('the pseudonym and the session start survive a refresh; the expiry does not', async () => {
    const link = await mkLink('edit')
    // ⚠️ The session start is set an hour BACK, deliberately. Minting with the default and comparing
    // the two tokens cannot see the defect this pin exists for: a refresh that dropped `ses` and let
    // the mint restart it would produce the same second, and `after.ses === before.ses` would hold —
    // measured, with the carry removed the whole file stayed green. An hour is not a sleep either;
    // nothing here waits on the clock (#851 was the same lesson in a git fixture).
    const startedAt = now() - 3600
    const first = await mkTok(link, { ses: startedAt })
    const before = claimsOf(first)
    expect(before.ses, 'the fixture, not the mint, decides when this session began').toBe(startedAt)

    const r = await refresh(link, first)
    expect(r.statusCode, r.body).toBe(200)
    const after = claimsOf((r.json() as { token: string }).token)

    expect(after.anonId, 'the pseudonym is the attribution key — it must not move').toBe(before.anonId)
    expect(after.ses, 'the ceiling counts from the first entry, not from the token in hand').toBe(startedAt)
    expect(after.capability).toBe(before.capability)
  })

  // ADR-248 §6 names this as its own acceptance, and it is the reason the pseudonym is called the
  // attribution key rather than a rate-limiting detail: the page a guest wrote before their token was
  // renewed and the one they wrote after have to be BY THE SAME PERSON. Asserted from the row, because
  // the create response does not carry `created_by` — the pin has to read where the attribution lands.
  it('attribution survives a refresh — both pages are by the same guest', async () => {
    const link = await mkLink('edit')
    const tok = await mkTok(link, { anonId: anon(), ses: now() - 3600 })

    const before = await createAsGuest(tok, 'written before the renewal')
    expect(before.statusCode, before.body).toBe(201)
    const beforeId = (before.json() as { id: string }).id
    createdPages.push(beforeId)

    const r = await refresh(link, tok)
    expect(r.statusCode, r.body).toBe(200)
    const renewed = (r.json() as { token: string }).token

    const after = await createAsGuest(renewed, 'written after the renewal')
    expect(after.statusCode, after.body).toBe(201)
    const afterId = (after.json() as { id: string }).id
    createdPages.push(afterId)

    const rows = await admin<{ id: string; created_by: string | null }[]>`
      SELECT id, created_by FROM pages WHERE id IN (${beforeId}, ${afterId})`
    expect(rows, 'both pages exist').toHaveLength(2)
    expect(rows[0]!.created_by, 'a guest is attributed by their pseudonym').toBe(rows[1]!.created_by)
    // The pseudonym goes in bare — `anon:<hex>` is already namespaced, so nothing prefixes it here.
    expect(rows[0]!.created_by, 'and it is the one the token carried, not a fresh one')
      .toBe(claimsOf(tok).anonId)
  })

  // The budgets are the reason the refresh is not the public mint. `normalizeRateMax` reads an unset
  // `tenant_settings` as Infinity, so a walk that does not set a cap first cannot fail and pins nothing.
  it('a budget keyed on the pseudonym is NOT reset by a refresh', async () => {
    const link = await mkLink('edit')
    const tok = await mkTok(link, { anonId: anon() })
    await admin`UPDATE tenant_settings SET abuse_create_page_link_max = 50, abuse_create_page_session_max = 1 WHERE tenant_id = ${TENANT}`

    const first = await createAsGuest(tok, 'within budget')
    expect(first.statusCode, first.body).toBe(201)
    createdPages.push((first.json() as { id: string }).id)
    expect((await createAsGuest(tok, 'over budget')).statusCode, 'the session cap is 1').toBe(429)

    const r = await refresh(link, tok)
    expect(r.statusCode, r.body).toBe(200)
    const renewed = (r.json() as { token: string }).token
    expect(claimsOf(renewed).anonId).toBe(claimsOf(tok).anonId)
    expect((await createAsGuest(renewed, 'still over budget')).statusCode,
      'an abuse ceiling a client can clear by asking for a new token is not a ceiling').toBe(429)
  })

  // An authorization pin, not tidiness: `anonId` is what a guest's pages are created with and what
  // rollback-by-actor selects on, so an input path lets one guest write under another's name.
  it('the pseudonym cannot be supplied in a body — not to the refresh, not to the exchange', async () => {
    const link = await mkLink('edit')
    const mine = await mkTok(link, { anonId: anon() })
    const theirs = 'anon:ffffffffffff'

    const r = await refresh(link, mine, { anonId: theirs })
    expect(r.statusCode, r.body).toBe(200)
    expect(claimsOf((r.json() as { token: string }).token).anonId).toBe(claimsOf(mine).anonId)

    const x = await exchange(link, { payload: { anonId: theirs } })
    expect(x.statusCode, x.body).toBe(200)
    expect(claimsOf((x.json() as { token: string }).token).anonId).not.toBe(theirs)
  })

  it('a refresh is not a visit — the funnel denominator does not move', async () => {
    const link = await mkLink('edit')
    let visits = 0
    registerFunnelCollector({ linkVisit: () => { visits++ }, workspaceCreated: () => {} })

    expect((await exchange(link)).statusCode).toBe(200)
    expect(visits, 'the exchange IS a visit').toBe(1)

    const tok = await mkTok(link)
    for (let i = 0; i < 3; i++) expect((await refresh(link, tok)).statusCode).toBe(200)
    expect(visits, 'a session continuing is not a visitor arriving').toBe(1)
  })
})

describe('#874 what a refresh may not get around', () => {
  it('a revoked link stops refreshing at once', async () => {
    const link = await mkLink('edit')
    const tok = await mkTok(link)
    expect((await refresh(link, tok)).statusCode).toBe(200)

    // No `content-type` on a bodyless write: Fastify answers 400 to a declared JSON body that is not there.
    const revoked = await app.inject({ method: 'DELETE', url: `/share-links/${link}`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(revoked.statusCode, revoked.body).toBe(204)
    expect((await refresh(link, tok)).statusCode, 'the refresh must not be a way around #100').toBe(404)
  })

  it('an expired token cannot be refreshed, and carries nothing forward', async () => {
    const link = await mkLink('edit')
    const dead = await mkTok(link, { anonId: anon(), ttlSeconds: -60 })
    expect((await refresh(link, dead)).statusCode, 'a genuinely ended session').toBe(401)

    // …and it cannot continue a session through the exchange either. Allowing that would let anyone
    // holding an old token claim to be the continuation of somebody else's session.
    const x = await exchange(link, { token: dead })
    expect(x.statusCode, x.body).toBe(200)
    expect(claimsOf((x.json() as { token: string }).token).anonId).not.toBe(claimsOf(dead).anonId)
  })

  it('a token for another link, or no token at all, gets nothing', async () => {
    const a = await mkLink('edit')
    const b = await mkLink('edit')
    expect((await refresh(b, await mkTok(a))).statusCode, 'the link id is checked against the claim').toBe(404)
    expect((await refresh(a, '')).statusCode).toBe(401)
    expect((await refresh(a, 'not.a.token')).statusCode).toBe(401)
  })
})

describe('#874 the twelve-hour ceiling', () => {
  it('a session past the ceiling is refused, and says so distinguishably from a dead link', async () => {
    const link = await mkLink('edit')
    const old = await mkTok(link, { ses: now() - GUEST_SESSION_CEILING_SECONDS - 60 })
    const r = await refresh(link, old)
    expect(r.statusCode).toBe(401)
    expect(r.json(), 'about the token the caller already holds — it reveals nothing about the link').toEqual({ error: 'session_ended' })
  })

  it('a session one minute short of the ceiling still refreshes — and the renewal is still that old', async () => {
    const link = await mkLink('edit')
    const startedAt = now() - GUEST_SESSION_CEILING_SECONDS + 60
    const nearly = await mkTok(link, { ses: startedAt })
    const r = await refresh(link, nearly)
    expect(r.statusCode, r.body).toBe(200)

    // The second hop, and the reason the first is not enough: a refresh could carry `ses` far enough
    // to pass the check above and still hand back a token that starts the clock again. Then the next
    // refresh would pass, and the next — a session that renews itself past twelve hours one token at
    // a time, which is the thing §3.7 ruled out. The renewed token has to be as old as the original.
    const renewed = claimsOf((r.json() as { token: string }).token)
    expect(renewed.ses, 'the renewal inherits the age; it does not begin a second session').toBe(startedAt)
    expect((await refresh(link, await mkTok(link, { ses: renewed.ses! - 120 }))).statusCode,
      'and two minutes further on, the same session is over').toBe(401)
  })

  // A token minted before `ses` shipped carries none. Reading it as `iat` errs toward ending the
  // session sooner, which is the safe direction; the alternative is a token that never ages.
  it('a token with no session start is aged by its issue time, not treated as new', async () => {
    const link = await mkLink('edit')
    // ⚠️ Signed here rather than minted: `mintGuestToken` fills `ses` in unconditionally, so asking it
    // for a token without one is impossible and an earlier version of this case settled for asserting
    // that the mint HAD set it — which walked the ordinary path and left `claims.ses ?? claims.iat`
    // unexercised. This is the pre-#874 shape byte for byte: every claim the mint writes, minus that one.
    const issuedAt = now() - GUEST_SESSION_CEILING_SECONDS + 120
    const legacy = await new SignJWT({
      tenantId: TENANT, shareLinkId: link, resource: { type: 'space', id: spaceId }, capability: 'edit',
      anonId: claimsOf(await mkTok(link)).anonId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'guest+jwt' })
      .setIssuedAt(issuedAt)
      .setExpirationTime(now() + 300)
      .sign(new TextEncoder().encode(guestCfg.secret))
    expect(claimsOf(legacy).ses, 'this token predates the claim — that is the whole case').toBeUndefined()

    const r = await refresh(link, legacy)
    expect(r.statusCode, r.body).toBe(200)
    // Aged by `iat`, so the renewal carries THAT as the session start rather than starting fresh.
    expect(claimsOf((r.json() as { token: string }).token).ses,
      'the issue time becomes the session start, so the ceiling still arrives').toBe(issuedAt)
  })

  it('and a legacy token already past the ceiling by its issue time is refused', async () => {
    // The other direction. Without it, reading `ses ?? iat` could fall back to `now` — the token would
    // never age, which the comment above calls the alternative it rejected — and the case above would
    // still pass, because a token that never ages refreshes happily.
    const link = await mkLink('edit')
    const old = await new SignJWT({
      tenantId: TENANT, shareLinkId: link, resource: { type: 'space', id: spaceId }, capability: 'edit',
      anonId: claimsOf(await mkTok(link)).anonId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'guest+jwt' })
      .setIssuedAt(now() - GUEST_SESSION_CEILING_SECONDS - 60)
      .setExpirationTime(now() + 300)
      .sign(new TextEncoder().encode(guestCfg.secret))
    const r = await refresh(link, old)
    expect(r.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: 'session_ended' })
  })

  it('a password link refreshes without a prompt inside the ceiling, and meets the door past it', async () => {
    const link = await mkLink('edit', 'hunter2')
    const inside = await mkTok(link, { anonId: anon() })
    expect((await refresh(link, inside)).statusCode, 'the presented token is the evidence').toBe(200)

    const past = await mkTok(link, { anonId: claimsOf(inside).anonId, ses: now() - GUEST_SESSION_CEILING_SECONDS - 60 })
    expect((await refresh(link, past)).statusCode).toBe(401)
    // The door is the exchange, and it asks for the password again — presenting the token does not
    // open it. Continuity of the pseudonym happens AFTER someone proves they may come in.
    const noPassword = await exchange(link, { token: past })
    expect(noPassword.statusCode).toBe(401)
    expect(noPassword.json()).toEqual({ error: 'password_required' })

    const withPassword = await exchange(link, { token: past, payload: { password: 'hunter2' } })
    expect(withPassword.statusCode, withPassword.body).toBe(200)
    const continued = claimsOf((withPassword.json() as { token: string }).token)
    expect(continued.anonId, 'the same person keeps the name their pages were created under').toBe(claimsOf(past).anonId)
    expect(continued.ses, 'but the session starts over — the ceiling is not renewed by continuing').toBeGreaterThan(claimsOf(past).ses!)
  })

  it('a password-less link past the ceiling re-exchanges and keeps its pseudonym', async () => {
    const link = await mkLink('edit')
    const past = await mkTok(link, { anonId: anon(), ses: now() - GUEST_SESSION_CEILING_SECONDS - 60 })
    expect((await refresh(link, past)).statusCode).toBe(401)

    const again = await exchange(link, { token: past })
    expect(again.statusCode, again.body).toBe(200)
    const continued = claimsOf((again.json() as { token: string }).token)
    expect(continued.anonId).toBe(claimsOf(past).anonId)
    expect(continued.ses).toBeGreaterThan(claimsOf(past).ses!)
  })
})
