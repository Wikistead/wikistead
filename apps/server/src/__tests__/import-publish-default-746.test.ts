// #746 (user ruling, 2026-08-19) — an import PUBLISHES unless the person says otherwise.
//
// ADR-132 chose the opposite, and what that produced on the running product was an import that
// reported success and left a wiki that looked empty: the read surface and the export both show the
// PUBLISHED version, and nothing had been published. ADR-236 answered it with a sentence on the
// report explaining why the pages looked blank. A default that has to be explained is the wrong
// default, and it was the single behaviour separating this importer from every comparable one.
//
// Measured through the SHIPPED ROUTE, because the default is a decision the route makes — a test
// calling `importArchive` directly would be measuring the materializer's parameter, which nobody
// experiences. And measured on the CONSEQUENCE (does the reader see the page, does the export carry
// bytes) rather than on `report.published`, because the count is what the importer says about itself
// while the empty page was what people actually met.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { resolveImportPublish, IMPORT_PUBLISHES_BY_DEFAULT } from '../import/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'

let app: FastifyInstance
let TENANT: string
let SPACE: string
let dispose: () => Promise<void>
let H: { host: string; authorization: string; 'content-type': string }

const ARCHIVE = () => zipSync({
  'Runbook.md': strToU8('# Runbook\n\nRestart the server, then check the logs.\n'),
  'Onboarding.md': strToU8('# Onboarding\n\nWelcome aboard.\n'),
})

const importArchiveVia = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST', url: `/spaces/${SPACE}/import`, headers: H,
    payload: JSON.stringify({ zipBase64: Buffer.from(ARCHIVE()).toString('base64'), ...body }),
  })

/** what a READER gets: the published snapshot, which is also what the export reads (#85). */
async function publishedBodies(): Promise<(string | null)[]> {
  const rows = await admin<{ published_md: string | null }[]>`
    SELECT published_md FROM pages WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} ORDER BY title`
  return rows.map((r) => r.published_md)
}

async function clearPages(): Promise<void> {
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT} AND space_id = ${SPACE}`
}

beforeAll(async () => {
  const t = await privateTenant(admin, 'imppub746')
  TENANT = t.id
  dispose = t.dispose
  const [space] = await admin<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Publish default') RETURNING id`
  SPACE = space!.id
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ])
  app = await buildApp()
  await app.ready()
  H = { host: `${t.slug}.localhost`, authorization: 'Bearer dev-token', 'content-type': 'application/json' }
}, 180_000)

afterAll(async () => {
  await app?.close()
  await deleteTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ]).catch(() => {})
  await dispose?.()
  await admin.end()
  await pool.end()
})

describe('#746: an import arrives visible', () => {
  it('with no choice made, the imported pages are published and a reader can see them', async () => {
    await clearPages()
    const res = await importArchiveVia({})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().pagesCreated).toBe(2)
    // The consequence, not the count: before #746 both of these were null and the wiki read as empty
    // immediately after a successful import.
    const bodies = await publishedBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies.every((b) => b != null && b.trim() !== ''),
      `every imported page has a published snapshot :: ${JSON.stringify(bodies)}`).toBe(true)
    expect(bodies.join('\n'), 'and it is the content, not an empty shell').toContain('Restart the server')
  }, 300_000)

  it('…and turning publishing off still lands drafts — the choice was kept, only its default moved', async () => {
    await clearPages()
    const res = await importArchiveVia({ publish: false })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().pagesCreated).toBe(2)
    expect(res.json().published, 'nothing published when it was declined').toBe(0)
    const bodies = await publishedBodies()
    expect(bodies.every((b) => b == null), `no published snapshot :: ${JSON.stringify(bodies)}`).toBe(true)
  }, 300_000)

  it('the two paths resolve the flag through ONE function, so sync and queued cannot disagree', () => {
    // The queued path writes the flag into its row and reads it back hours later. When the default
    // moved, a second coercion sitting in that INSERT would have quietly kept the old behaviour for
    // exactly the large archives nobody watches finish.
    expect(resolveImportPublish(undefined), 'no choice means the default').toBe(IMPORT_PUBLISHES_BY_DEFAULT)
    expect(resolveImportPublish(false), 'an explicit no is honoured').toBe(false)
    expect(resolveImportPublish(true)).toBe(true)
    expect(IMPORT_PUBLISHES_BY_DEFAULT, '#746: publishing is the default').toBe(true)
  })
})
