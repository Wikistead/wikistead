// Integration tests — real Meilisearch + real OpenFGA + real Fastify, no mocks.
// P2: in-body CJK search + body snippets, with the two-stage guard intact. The
// two load-bearing proofs are
// point 1 — matches a page whose BODY contains (the exact case
// a PG-tokenizer competitor returns 0 results for); and
// point 2 — a doubly-relevant but UNAUTHORIZED doc leaks nothing through search
// not its id, title, body, or the wider-surface snippet.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/driver.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'
import type { SearchDoc } from '@wikistead/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let app: FastifyInstance

// Test doc ids (cleaned up afterwards).
const HIT = 'cjk-hit-1' // authorized, body has
const ENG = 'cjk-eng-1' // english body (non-regression)
const MIX = 'cjk-mix-1' // english + japanese body
const STALE = 'cjk-stale-1' // stage1 passes (viewerUsers) but NO FGA grant → stage2 drops

function doc(over: Partial<SearchDoc> & Pick<SearchDoc, 'id' | 'body'>): SearchDoc {
  return {
    tenantId: tenant.id, spaceId: 'demo_space', title: 'untitled',
    viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
    ...over,
  }
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  await driver.ensureIndex() // title + body searchable
  app = await buildApp()
  await app.ready()

  // upsertDoc awaits waitForTask → indexed synchronously, no polling needed.
  await driver.upsertDoc(doc({ id: HIT, title: '行政ページ', body: '東京都庁は新宿にある。まとめwikiのテスト。' }))
  await driver.upsertDoc(doc({ id: ENG, title: 'english', body: 'the quick brown fox jumps over the lazy dog' }))
  await driver.upsertDoc(doc({ id: MIX, title: 'mixed', body: 'this page is about ramen 東京 style noodles' }))
  await driver.upsertDoc(doc({ id: STALE, title: 'SECRETTITLE秘密', body: '機密SENSITIVE 東京都庁 のメモ' }))

  // Authorize dev-user to VIEW only the legitimate docs (NOT the stale one).
  await writeTuples(fgaClient, [
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${HIT}` },
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${ENG}` },
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${MIX}` },
  ])
})

afterAll(async () => {
  for (const id of [HIT, ENG, MIX, STALE]) await driver.deleteDoc(id).catch(() => {})
  await deleteTuples(fgaClient, [
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${HIT}` },
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${ENG}` },
    { user: 'user:dev-user', relation: 'view_direct', object: `page:${MIX}` },
  ]).catch(() => {})
  await app.close()
  await pool.end()
})

const stage1 = (q: string) => driver.search({ tenantId: tenant.id, userId: 'dev-user', groups: [], q })

// ── point 1: in-body CJK match (Docmost returns 0 here) ─────────────────────
describe('CJK in-body match', () => {
  it('"東京都" matches a page whose BODY contains "東京都庁" (title unrelated)', async () => {
    const hits = await stage1('東京都')
    expect(hits.some((h) => h.id === HIT)).toBe(true)
  })
  it('mid-text Japanese keywords match: 都庁 / 新宿 / まとめ', async () => {
    for (const q of ['都庁', '新宿', 'まとめ']) {
      expect((await stage1(q)).some((h) => h.id === HIT), `query ${q}`).toBe(true)
    }
  })
})

// ── point 4: body snippet (plain text excerpt around the match) ──────────────
describe('body snippet', () => {
  it('returns a plain-text snippet containing the matched Japanese term', async () => {
    const hit = (await stage1('都庁')).find((h) => h.id === HIT)
    expect(hit?.snippet).toBeTruthy()
    expect(hit!.snippet).toContain('都庁')
    expect(hit!.snippet).not.toContain('<em>') // plain text — no highlight markup (no XSS surface)
  })
})

// ── point 3: non-regression (english + multilingual) ────────────────────────
describe('non-regression', () => {
  it('english body still matches an english query', async () => {
    expect((await stage1('brown')).some((h) => h.id === ENG)).toBe(true)
  })
  it('a mixed english/japanese body matches in BOTH languages', async () => {
    expect((await stage1('ramen')).some((h) => h.id === MIX)).toBe(true)
    expect((await stage1('東京')).some((h) => h.id === MIX)).toBe(true)
  })
})

// ── point 2: the two-stage guard holds for CJK — no leak of the wider snippet ─
describe('two-stage guard (CJK): unauthorized doc leaks nothing', () => {
  it('a CJK-relevant but unauthorized doc is dropped — no id/title/body/snippet', async () => {
    // Stage 1 alone WOULD surface it (viewerUsers contains dev-user + body matches)...
    expect((await stage1('東京都庁')).some((h) => h.id === STALE)).toBe(true)

    // ...but the route (stage1 → FGA stage2) must not return it, nor any of its text.
    const res = await app.inject({
      method: 'GET', url: '/search?q=' + encodeURIComponent('東京都庁'),
      headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
    })
    expect(res.statusCode).toBe(200)
    const hits = res.json() as { id: string }[]
    expect(hits.some((h) => h.id === STALE)).toBe(false) // dropped by stage2
    expect(hits.some((h) => h.id === HIT)).toBe(true) // the authorized one still returns

    // Hard guarantee: NONE of the unauthorized doc's text appears anywhere in the
    // response — not the title, not the body, not the (wider-surface) snippet.
    const raw = res.payload
    expect(raw).not.toContain('SECRETTITLE秘密')
    expect(raw).not.toContain('機密SENSITIVE')
    expect(raw).not.toContain(STALE)
  })
})
