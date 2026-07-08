// #104 / ADR-038: a space-link guest VIEWS the space's pages over HTTP. Real Postgres +
// OpenFGA + Fastify. The space token lists the space pages and reads any in-space published
// page; an out-of-space page is denied (FGA re-derives authority; never a cross-space leak).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SA = 'sgv-space-a'
const SB = 'sgv-space-b'
const PA = 'sgv-page-a' // published, in SA
const PB = 'sgv-page-b' // published, in SB (out of the link's space)
const LINK = 'sgv-space-link'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let app: FastifyInstance
let spaceTok: string
const tuples = [
  { user: `share_link:${LINK}`, relation: 'viewer', object: `space:${SA}` }, // space link → SA
  { user: `space:${SA}`, relation: 'space', object: `page:${PA}` }, // PA published in SA
  { user: `space:${SB}`, relation: 'space', object: `page:${PB}` }, // PB published in SB
]
const H = { host: 'dev.localhost', authorization: '' as string }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  for (const [s, name] of [[SA, 'A'], [SB, 'B']] as const) {
    await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s}, ${TENANT}, ${name}) ON CONFLICT (id) DO NOTHING`
  }
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PA}, ${TENANT}, ${SA}, 'PA', 'A body', now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PB}, ${TENANT}, ${SB}, 'PB', 'B body', now()) ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, tuples)
  spaceTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: LINK, resource: { type: 'space', id: SA }, capability: 'view' })
  H.authorization = `Bearer ${spaceTok}`
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, tuples).catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${PA}, ${PB})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id IN (${SA}, ${SB})`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#104 space-link guest HTTP view', () => {
  it('lists the linked space pages (the navigation source)', async () => {
    const res = await app.inject({ method: 'GET', url: `/spaces/${SA}/pages`, headers: H })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }[]).map((p) => p.id)).toContain(PA)
  })

  it('reads an in-space published page', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PA}/published`, headers: H })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { publishedMd: string | null }).publishedMd).toBe('A body')
  })

  it('is DENIED an out-of-space page (no cross-space leak)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PB}/published`, headers: H })
    // #262: a view-denied page read is 404 (existence-hiding — never confirm the page exists), not 403.
    // A cross-space guest leaks LESS with 404 than 403. (The list endpoint below stays 403 = token-scope.)
    expect(res.statusCode).toBe(404)
  })

  it('cannot list another space pages with this link (403)', async () => {
    const res = await app.inject({ method: 'GET', url: `/spaces/${SB}/pages`, headers: H })
    expect(res.statusCode).toBe(403) // token is bound to SA
  })
})
