// #376 / ADR-149 §2: the anonymous /public/* resource resolvers — the review-ratified anti-tests.
// Real Postgres + OpenFGA + Fastify. Pins: the ordered public gate (tenant switch → ANON view →
// published_at) with the LOAD-BEARING public-but-UNPUBLISHED case (ANON view alone passes a
// public-toggled draft — the DB gate must stop it); source-membership refusal (400) BEFORE any render
// for a non-page plantuml source; existence-hiding on the public transclude (member-only ≡ unpublished
// ≡ absent = uniform 404); cross-tenant attachment ids are a uniform 404 (RLS no-row); and the
// per-IP rate cap trips (bounded, then 429).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { extractPlantumlFences } from '../routes/public.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let TENANT: string
let host: { host: string }
const UML = '@startuml\nA -> B\n@enduml'

let app: FastifyInstance
let pt: PrivateTenant
let db: TenantDb
let spaceId: string
let pubPage: string      // published + public (ANON-viewable)
let draftPub: string     // public-TOGGLED but UNPUBLISHED (the load-bearing case)
let memberPage: string   // published, NOT public
let att: string          // confirmed attachment on pubPage
let attDraft: string     // confirmed attachment on draftPub
let attForeign: string   // confirmed attachment in ANOTHER tenant
const cleanupTuples: { user: string; relation: string; object: string }[] = []

const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))

async function mkPage(title: string, opts: { publish?: boolean; makePublic?: boolean; body?: string } = {}): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title })
  if (opts.body) await admin`UPDATE pages SET ydoc = ${ydoc(opts.body)} WHERE id = ${p.id}`
  if (opts.publish) await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  if (opts.makePublic) {
    const t = { user: 'user:*', relation: 'view_base', object: `page:${p.id}` }
    await writeTuples(fgaClient, [t]); cleanupTuples.push(t)
  }
  return p.id
}

async function mkAttachment(tenantId: string, pageId: string, key: string): Promise<string> {
  const id = `att376-${key}`
  await storage.putObject(`${tenantId}/376/${id}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'image/png')
  await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status, size_bytes, confirmed_at, inline_kind)
    VALUES (${id}, ${tenantId}, ${pageId}, 'x.png', 'image/png', ${`${tenantId}/376/${id}.png`}, 'confirmed', 8, now(), 'image')
    ON CONFLICT (id) DO NOTHING`
  return id
}

beforeAll(async () => {
  // #1090: a private tenant — 10 files were fighting over `tenant_dev`'s single tenant_settings row.
  // `tenant_acme` below (the foreign attachment) stays as-is — a deliberate second real tenant for
  // the cross-tenant existence-hiding case, not part of the race this ticket fixes.
  pt = await privateTenant(admin, 't376')
  TENANT = pt.id
  host = { host: `${pt.slug}.localhost` }
  app = await buildApp(); await app.ready()
  await driver.ensureIndex(); await storage.ensureBucket()
  await admin`INSERT INTO tenant_settings (tenant_id, public_enabled) VALUES (${TENANT}, true)
    ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = true`
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `pub376-${Date.now().toString(36)}` })).id
  pubPage = await mkPage('pub376 page', { body: `intro\n\n\`\`\`plantuml\n${UML}\n\`\`\`\n`, publish: true, makePublic: true })
  draftPub = await mkPage('pub376 draft', { body: 'draft body', makePublic: true }) // public-toggled, NEVER published
  memberPage = await mkPage('pub376 member', { body: 'members only', publish: true })
  att = await mkAttachment(TENANT, pubPage, 'pub')
  attDraft = await mkAttachment(TENANT, draftPub, 'draft')
  attForeign = await mkAttachment('tenant_acme', 'acme_page', 'foreign')
  // clear this window's public-render rate buckets so a rerun within the window can't start limited.
  await app.valkey.del('rl:pubuml:t:' + TENANT).catch(() => {})
  const keys = await app.valkey.keys('rl:pubuml:ip:*').catch(() => [])
  if (keys.length) await app.valkey.del(...keys).catch(() => {})
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanupTuples).catch(() => {})
  for (const id of [pubPage, draftPub, memberPage]) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await admin`DELETE FROM attachments WHERE id LIKE 'att376-%'`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM tenant_settings WHERE tenant_id = ${TENANT}`.catch(() => {})
  await pt.dispose()
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('extractPlantumlFences (membership set)', () => {
  it('extracts multiple fences, tolerates info tails and longer fences, skips unclosed', () => {
    const md = '```plantuml\nA\n```\n\n````plantuml align=left\nB\nline2\n````\n\n```mermaid\nX\n```\n\n```plantuml\nunclosed'
    expect(extractPlantumlFences(md)).toEqual(['A', 'B\nline2'])
  })
})

describe('/public/attachments (#376)', () => {
  it('serves a PUBLIC PUBLISHED page’s attachment anonymously', async () => {
    const r = await app.inject({ method: 'GET', url: `/public/attachments/${att}/download`, headers: host })
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { downloadUrl: string }).downloadUrl).toBeTruthy()
  })

  it('LOAD-BEARING: a public-toggled but UNPUBLISHED page’s attachment is a uniform 404', async () => {
    const r = await app.inject({ method: 'GET', url: `/public/attachments/${attDraft}/download`, headers: host })
    expect(r.statusCode).toBe(404) // ANON view passes (the toggle), but published_at gates it
  })

  it('a member-only page’s attachment and a cross-tenant attachment are the SAME uniform 404', async () => {
    const attMember = await mkAttachment(TENANT, memberPage, 'member')
    const r1 = await app.inject({ method: 'GET', url: `/public/attachments/${attMember}/download`, headers: host })
    const r2 = await app.inject({ method: 'GET', url: `/public/attachments/${attForeign}/download`, headers: host })
    expect(r1.statusCode).toBe(404)
    expect(r2.statusCode).toBe(404)
    expect(r1.body).toBe(r2.body) // byte-identical (no oracle between "not public" and "not yours")
  })

  it('the tenant public master switch OFF hides everything (uniform 404)', async () => {
    await admin`UPDATE tenant_settings SET public_enabled = false WHERE tenant_id = ${TENANT}`
    try {
      const r = await app.inject({ method: 'GET', url: `/public/attachments/${att}/download`, headers: host })
      expect(r.statusCode).toBe(404)
    } finally {
      await admin`UPDATE tenant_settings SET public_enabled = true WHERE tenant_id = ${TENANT}`
    }
  })
})

describe('/public/pages/:id/plantuml/render (#376 abuse bounds)', () => {
  it('refuses a source that is NOT a fence of this page (400, BEFORE any render)', async () => {
    const r = await app.inject({ method: 'POST', url: `/public/pages/${pubPage}/plantuml/render`, headers: { ...host, 'content-type': 'application/json' }, payload: { source: '@startuml\nEVIL -> AMPLIFY\n@enduml' } })
    expect(r.statusCode).toBe(400)
  })

  it('accepts the page’s own fence source (degrades 204 here — no renderer configured — proving it passed the membership gate)', async () => {
    const r = await app.inject({ method: 'POST', url: `/public/pages/${pubPage}/plantuml/render`, headers: { ...host, 'content-type': 'application/json' }, payload: { source: UML, theme: 'dark' } })
    expect([200, 204]).toContain(r.statusCode) // 204 = unconfigured Kroki (test env); 200 if an operator URL exists
  })

  it('a public-but-unpublished page 404s and a member-only page 404s (same gate as attachments)', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/public/pages/${draftPub}/plantuml/render`, headers: { ...host, 'content-type': 'application/json' }, payload: { source: UML } })
    const r2 = await app.inject({ method: 'POST', url: `/public/pages/${memberPage}/plantuml/render`, headers: { ...host, 'content-type': 'application/json' }, payload: { source: UML } })
    expect(r1.statusCode).toBe(404)
    expect(r2.statusCode).toBe(404)
  })

  it('the per-IP fixed-window cap trips at the bound (429 after 30 misses in the window)', async () => {
    let limited = 0
    for (let i = 0; i < 32; i++) {
      const r = await app.inject({ method: 'POST', url: `/public/pages/${pubPage}/plantuml/render`, headers: { ...host, 'content-type': 'application/json' }, payload: { source: UML } })
      if (r.statusCode === 429) limited++
    }
    expect(limited, 'the tail of the burst is rate-limited').toBeGreaterThanOrEqual(1)
    const keys = await app.valkey.keys('rl:pubuml:ip:*').catch(() => [])
    if (keys.length) await app.valkey.del(...keys).catch(() => {}) // leave the window clean for reruns
    await app.valkey.del('rl:pubuml:t:' + TENANT).catch(() => {})
  }, 30_000)
})

describe('/public/pages/:id/transclude/:ref (#376 existence-hiding)', () => {
  it('resolves a PUBLIC ref; a member-only ref, an unpublished ref and an absent ref are the SAME 404', async () => {
    const ok = await app.inject({ method: 'GET', url: `/public/pages/${pubPage}/transclude/${pubPage}`, headers: host })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((ok.json() as { content: string }).content).toContain('intro')
    const denied = await Promise.all([
      app.inject({ method: 'GET', url: `/public/pages/${pubPage}/transclude/${memberPage}`, headers: host }),
      app.inject({ method: 'GET', url: `/public/pages/${pubPage}/transclude/${draftPub}`, headers: host }),
      app.inject({ method: 'GET', url: `/public/pages/${pubPage}/transclude/00000000-0000-0000-0000-000000000000`, headers: host }),
    ])
    for (const r of denied) expect(r.statusCode).toBe(404)
    expect(new Set(denied.map((r) => r.body)).size, 'all denials byte-identical (no oracle)').toBe(1)
  })

  it('a NON-public host page cannot be used as a transclude proxy (404 on the host gate)', async () => {
    const r = await app.inject({ method: 'GET', url: `/public/pages/${memberPage}/transclude/${pubPage}`, headers: host })
    expect(r.statusCode).toBe(404)
  })
})
