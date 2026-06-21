// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// Closes the exact gap diagnosed for full-text search: page BODY is written by the
// collab server, which only ENQUEUES a search_outbox 'upsert'; nothing drained it,
// so body text never reached Meili. This drives the REAL pipeline (a collab-style
// enqueue → drainOutbox → Meili) — the path P2's direct-Meili-insert tests skipped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { drainOutbox } from '../search/index.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SPACE = 'obx-space'
const PAGE = 'outbox-drain-page'
const TOKEN = `obxbody${Date.now().toString(36)}` // unique → avoids accumulated Meili cruft
// Self-contained space (other test files delete the shared demo fixtures). dev-user
// is tenant_dev admin (seed) → space admin → page view via inheritance.
const fgaFixture = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
]

const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))
let app: FastifyInstance

const search = async (q: string) => {
  const res = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
  return (res.json() as { id: string }[]).map((h) => h.id)
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Outbox Space') ON CONFLICT (id) DO NOTHING`
  // A page with BODY content only (the token is NOT in the title).
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc)
              VALUES (${PAGE}, ${TENANT}, ${SPACE}, 'Plain Title', ${ydoc(`# Plain Title\n\n${TOKEN} 東京都庁の本文\n`)})
              ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, fgaFixture)
  // Mimic the collab server: enqueue an 'upsert' WITHOUT any inline processing.
  await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${PAGE}, 'upsert')`
})

afterAll(async () => {
  await app.searchDriver.deleteDoc(PAGE).catch(() => {})
  await deleteTuples(fgaClient, fgaFixture).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${PAGE}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${PAGE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await app.close()
  await admin.end()
  await pool.end()
})

describe('search outbox drain (collab body → full-text)', () => {
  it('a body-only term is NOT searchable until the outbox is drained, then IS', async () => {
    // Before draining the collab-enqueued row, the body isn't in Meili.
    expect(await search(TOKEN)).not.toContain(PAGE)

    const processed = await drainOutbox(app.searchDriver)
    expect(processed).toBeGreaterThan(0)

    // After the drain, the body term finds the page via the real two-stage route.
    expect(await search(TOKEN)).toContain(PAGE)
    // the outbox row was consumed on success.
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM search_outbox WHERE page_id = ${PAGE}`
    expect(n).toBe(0)
  })

  it('drainOutbox is idempotent on an empty queue (no rows → 0 processed)', async () => {
    expect(await drainOutbox(app.searchDriver)).toBe(0)
  })
})
