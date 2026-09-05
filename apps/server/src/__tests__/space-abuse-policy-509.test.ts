// #509 / ADR-187: per-space moderation policy = tenant floor ⊕ space ADDITIVE layer. The security
// invariant is that a space can NEVER weaken the tenant floor (banned words UNION, shrink ratio
// STRICTER-wins). Pure resolver tests pin the merge algebra; real-stack tests pin the moderate-gate
// (moderator OR manager, not plain member) and that the effective policy is what a publish is judged
// against.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import { resolveEffectiveAbusePolicy } from '../routes/abuse-config.js'
import type { Tenant } from '@wikistead/types'

// ── pure resolver (the merge algebra — the "floor can never be weakened" invariant) ──
describe('#509 / ADR-187: resolveEffectiveAbusePolicy (tenant floor ⊕ space layer, additive only)', () => {
  it('banned words UNION — a space adds, never removes a tenant-banned word', () => {
    const eff = resolveEffectiveAbusePolicy({ shrinkRatio: null, bannedWords: ['spam', 'scam'] }, { shrinkRatio: null, bannedWords: ['banana'] })
    expect(new Set(eff.bannedWords)).toEqual(new Set(['spam', 'scam', 'banana']))
  })
  it('a space CANNOT drop a tenant-banned word (the layer is additive)', () => {
    // even with an empty space list, every tenant word survives
    const eff = resolveEffectiveAbusePolicy({ shrinkRatio: null, bannedWords: ['spam'] }, { shrinkRatio: null, bannedWords: [] })
    expect(eff.bannedWords).toContain('spam')
  })
  it('shrink ratio is STRICTER-wins (MAX) — a space cannot LOWER the tenant floor', () => {
    // tenant floor 0.5; space tries 0.1 (weaker) → floor holds at 0.5
    expect(resolveEffectiveAbusePolicy({ shrinkRatio: 0.5, bannedWords: [] }, { shrinkRatio: 0.1, bannedWords: null }).shrinkRatio).toBe(0.5)
    // space stricter (0.8) wins
    expect(resolveEffectiveAbusePolicy({ shrinkRatio: 0.5, bannedWords: [] }, { shrinkRatio: 0.8, bannedWords: null }).shrinkRatio).toBe(0.8)
  })
  it('NULL fields inherit — space null → tenant value; both null → off', () => {
    expect(resolveEffectiveAbusePolicy({ shrinkRatio: 0.3, bannedWords: ['a'] }, { shrinkRatio: null, bannedWords: null }))
      .toEqual({ shrinkRatio: 0.3, bannedWords: ['a'] })
    expect(resolveEffectiveAbusePolicy({ shrinkRatio: null, bannedWords: [] }, { shrinkRatio: null, bannedWords: null }))
      .toEqual({ shrinkRatio: null, bannedWords: [] })
  })
  it('space alone enables the floor — tenant off, space sets a word/ratio', () => {
    const eff = resolveEffectiveAbusePolicy({ shrinkRatio: null, bannedWords: [] }, { shrinkRatio: 0.2, bannedWords: ['x'] })
    expect(eff).toEqual({ shrinkRatio: 0.2, bannedWords: ['x'] })
  })
})

// ── real stack: the moderate-gate + effective policy at publish ──
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const tag = Date.now().toString(36)

let app: FastifyInstance
let db: TenantDb
let spaceId: string
// #1113: a PRIVATE tenant, not tenant_dev — the second describe block below writes the TENANT floor
// directly (that IS what "a space cannot lower the tenant floor" tests), and tenant_dev's row is the
// same one abuse-config-491/abuse-publish-328/patrol-flags-326 all mutate. vitest runs these files as
// concurrent workers, so a concurrent reset could always land between this file's SET and its
// assertion — the exact race that turned this file's own "GET effective shows the stricter (tenant)
// value" assertion from 0.5 into a concurrently-reset 0.1 (measured, this ticket).
let pt: PrivateTenant
const pageIds: string[] = []
const MOD = `mod509-${tag}`
const MEMBER = `member509-${tag}`

beforeAll(async () => {
  await driver.ensureIndex(); await storage.ensureBucket()
  pt = await privateTenant(admin, 't509')
  // See #1113's note in abuse-config-491.test.ts: updateAbuseFilterConfig's write is a plain
  // `UPDATE ... WHERE tenant_id` with no upsert, so the row must exist before the tenant-floor test
  // below writes it directly.
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${pt.id}) ON CONFLICT (tenant_id) DO NOTHING`
  db = await acquireTenantDb(asTenant(pt.id))
  app = await buildApp(); await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: pt.id, userId: 'dev-user', plan: 'free', name: `space509-${tag}` })).id
  await ensureMembers(pt.id, [MOD, MEMBER])
  // MOD is a space moderator (not a manager); MEMBER has no space grant.
  await writeTuples(fgaClient, [{ user: `user:${MOD}`, relation: 'moderator', object: `space:${spaceId}` }])
}, 40_000)

afterEach(async () => {
  await admin`UPDATE tenant_settings SET abuse_shrink_ratio = NULL, abuse_banned_words = ${[] as string[]} WHERE tenant_id = ${pt.id}`.catch(() => {})
  await admin`UPDATE space_settings SET abuse_shrink_ratio = NULL, abuse_banned_words = NULL WHERE space_id = ${spaceId}`.catch(() => {})
})

afterAll(async () => {
  for (const id of pageIds) await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${MOD}`, relation: 'moderator', object: `space:${spaceId}` }]).catch(() => {})
  await deleteTuples(fgaClient, memberTuples(pt.id, [MOD, MEMBER])).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app.close(); await db.release(); await valkey.quit()
  await pt.dispose().catch(() => {})
  await admin.end(); await pool.end()
}, 40_000)

const patchSpace = (body: unknown, auth: Record<string, string>) =>
  app.inject({ method: 'PATCH', url: `/spaces/${spaceId}/abuse-filter`, headers: { host: pt.H.host, 'content-type': 'application/json', ...auth }, payload: JSON.stringify(body) })
const getSpace = (auth: Record<string, string>) =>
  app.inject({ method: 'GET', url: `/spaces/${spaceId}/abuse-filter`, headers: { host: pt.H.host, ...auth } })

async function cookieFor(sub: string): Promise<Record<string, string>> {
  const sid = await createSession(valkey, { tenantId: pt.id, sub })
  return { cookie: `${SESSION_COOKIE}=${sid}` }
}
const publishedPage = async (body: string): Promise<string> => {
  const p = await createPage(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user', title: 'sp509' })
  pageIds.push(p.id)
  await admin`UPDATE pages SET ydoc = ${ydoc(body)} WHERE id = ${p.id}`
  await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  return p.id
}
const republish = (id: string, body: string) =>
  admin`UPDATE pages SET ydoc = ${ydoc(body)} WHERE id = ${id}`.then(() =>
    publishPage(db, fgaClient, driver, storage, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' }))

describe('#509 / ADR-187: the space abuse-filter is moderate-gated', () => {
  it('a space MODERATOR (not a manager) may read + write the space layer', async () => {
    const mod = await cookieFor(MOD)
    expect((await getSpace(mod)).statusCode).toBe(200)
    const w = await patchSpace({ bannedWords: ['banana'] }, mod)
    expect(w.statusCode).toBe(200)
    expect(w.json()).toMatchObject({ bannedWords: ['banana'] })
  })
  it('a tenant ADMIN (dev-user, manager superset) may write too', async () => {
    const w = await patchSpace({ shrinkRatio: 0.3 }, { authorization: 'Bearer dev-token' })
    expect(w.statusCode).toBe(200)
    expect(w.json()).toMatchObject({ shrinkRatio: 0.3 })
  })
  it('a plain MEMBER (no moderate) is 403 on BOTH read and write', async () => {
    const member = await cookieFor(MEMBER)
    expect((await getSpace(member)).statusCode).toBe(403)
    expect((await patchSpace({ bannedWords: ['x'] }, member)).statusCode).toBe(403)
  })
})

describe('#509 / ADR-187: the EFFECTIVE policy governs publish (floor can never be weakened)', () => {
  it('a space-added banned word rejects a publish even when the tenant floor is empty', async () => {
    const id = await publishedPage('clean start')
    await patchSpace({ bannedWords: ['banana'] }, { authorization: 'Bearer dev-token' })
    await expect(republish(id, 'clean start with banana added'), 'the space word trips the filter')
      .rejects.toMatchObject({ statusCode: 422, reason: 'banned_content' })
  })
  it('a space CANNOT lower the tenant shrink floor: GET effective shows the stricter (tenant) value', async () => {
    await admin`UPDATE tenant_settings SET abuse_shrink_ratio = 0.5 WHERE tenant_id = ${pt.id}`
    await patchSpace({ shrinkRatio: 0.1 }, { authorization: 'Bearer dev-token' }) // try to weaken
    const eff = (await getSpace({ authorization: 'Bearer dev-token' })).json() as { effective: { shrinkRatio: number } }
    expect(eff.effective.shrinkRatio, 'the tenant floor holds').toBe(0.5)
  })
})
