// Integration tests — real Postgres, no Hocuspocus server needed.
// Tests the loadYdoc / storeYdoc functions directly.
// Prerequisites: docker compose up -d postgres && pnpm migrate
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Y from 'yjs'
import postgres from 'postgres'
import { loadYdoc, storeYdoc } from '../ydoc.js'
import { pool } from '../db.js'

// Admin pool: bypasses RLS for test setup / teardown.
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

// Create isolated test space + page so tests don't depend on FGA seed data.
// (FGA seed creates OpenFGA tuples, not DB rows — we need actual DB rows here.)
let testPageId: string
let testSpaceId: string
const TENANT = 'tenant_dev'

beforeAll(async () => {
  const [{ id: sid }] = await adminPool<[{ id: string }]>`
    INSERT INTO spaces (tenant_id, name) VALUES (${TENANT}, 'ydoc-test-space') RETURNING id
  `
  testSpaceId = sid
  const [{ id: pid }] = await adminPool<[{ id: string }]>`
    INSERT INTO pages (tenant_id, space_id, title)
    VALUES (${TENANT}, ${testSpaceId}, 'ydoc-test-page')
    RETURNING id
  `
  testPageId = pid
})

afterAll(async () => {
  await adminPool`DELETE FROM spaces WHERE id = ${testSpaceId}`  // CASCADE removes pages
  await adminPool.end()
  await pool.end()
})

// ── loadYdoc ────────────────────────────────────────────────────────────

describe('loadYdoc', () => {
  it('returns null for a page with no saved ydoc', async () => {
    const result = await loadYdoc(TENANT, testPageId)
    expect(result).toBeNull()
  })

  it('returns null for a non-existent page (RLS blocks, not throws)', async () => {
    const result = await loadYdoc(TENANT, 'nonexistent-page-xyz')
    expect(result).toBeNull()
  })
})

// ── storeYdoc ───────────────────────────────────────────────────────────

describe('storeYdoc', () => {
  it('stores ydoc binary and returns stored=true', async () => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'initial content')
    const state = Y.encodeStateAsUpdate(doc)

    const { stored } = await storeYdoc(TENANT, testPageId, state)
    expect(stored).toBe(true)

    // Verify the binary is in Postgres
    const [row] = await adminPool<[{ ydoc: Buffer }]>`SELECT ydoc FROM pages WHERE id = ${testPageId}`
    expect(row.ydoc).toBeTruthy()
  })

  it('returns stored=false for a non-existent page (0-row UPDATE)', async () => {
    // This is the 0-row detection test: RLS or missing page causes silent 0-row UPDATE.
    // storeYdoc must detect this and return stored=false rather than silently discarding.
    const { stored } = await storeYdoc(TENANT, 'nonexistent-page-xyz', new Uint8Array([1, 2, 3]))
    expect(stored).toBe(false)
  })

  it('marks the page has_unpublished_changes on a draft save (cheap sidebar-badge flag)', async () => {
    await adminPool`UPDATE pages SET has_unpublished_changes = false WHERE id = ${testPageId}`
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'edited draft')
    await storeYdoc(TENANT, testPageId, Y.encodeStateAsUpdate(doc))
    const [row] = await adminPool<[{ has_unpublished_changes: boolean }]>`
      SELECT has_unpublished_changes FROM pages WHERE id = ${testPageId}`
    expect(row.has_unpublished_changes).toBe(true)
  })

  it('does NOT enqueue search_outbox on a draft save (publish reindexes, not the draft)', async () => {
    // Draft/publish model: storeYdoc only autosaves the draft. Search/export reflect
    // the PUBLISHED version, reindexed solely by POST /pages/:id/publish — a draft
    // save must NOT reindex, otherwise in-progress (unpublished) body would leak.
    await adminPool`DELETE FROM search_outbox WHERE page_id = ${testPageId}`
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'draft-only body')
    const { stored } = await storeYdoc(TENANT, testPageId, Y.encodeStateAsUpdate(doc))
    expect(stored).toBe(true)
    const rows = await adminPool`SELECT id FROM search_outbox WHERE page_id = ${testPageId}`
    expect(rows).toHaveLength(0)
  })

  it('returns stored=false for a cross-tenant write (RLS blocks)', async () => {
    // Try to store ydoc for a page that belongs to tenant_acme using tenant_dev context.
    // RLS silently blocks the UPDATE → 0 rows → stored=false.
    const [{ id: acmeSpace }] = await adminPool<[{ id: string }]>`
      INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'ydoc-cross-tenant-space') RETURNING id
    `
    const [{ id: acmePage }] = await adminPool<[{ id: string }]>`
      INSERT INTO pages (tenant_id, space_id, title)
      VALUES ('tenant_acme', ${acmeSpace}, 'cross-tenant-test-ydoc')
      RETURNING id
    `
    try {
      const { stored } = await storeYdoc(TENANT, acmePage, new Uint8Array([99]))
      expect(stored).toBe(false)
    } finally {
      await adminPool`DELETE FROM spaces WHERE id = ${acmeSpace}`
    }
  })
})

// ── Round-trip: store then load into a fresh Y.Doc ──────────────────────

describe('ydoc round-trip', () => {
  it('load into fresh Y.Doc recovers content from Postgres (not from memory)', async () => {
    // Create content in a source document and persist it.
    const srcDoc = new Y.Doc()
    srcDoc.getText('content').insert(0, 'hello collab persistence')
    const state = Y.encodeStateAsUpdate(srcDoc)

    const { stored } = await storeYdoc(TENANT, testPageId, state)
    expect(stored).toBe(true)

    // Load into a BRAND NEW Y.Doc — not the same instance as srcDoc.
    // This verifies we are reading from Postgres, not from any in-memory cache.
    const binary = await loadYdoc(TENANT, testPageId)
    expect(binary).not.toBeNull()

    const restoredDoc = new Y.Doc()   // empty; state will come only from Postgres
    Y.applyUpdate(restoredDoc, binary!)
    expect(restoredDoc.getText('content').toString()).toBe('hello collab persistence')
  })
})
