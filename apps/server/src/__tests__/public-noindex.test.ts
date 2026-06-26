// #124: a public page flagged noindex must emit the HTTP X-Robots-Tag: noindex header so a
// crawler is told not to index it (authoritative even before any HTML/SSR layer). Real
// Postgres + OpenFGA, driven through the HTTP layer via app.inject (Host → tenant).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let app: FastifyInstance
let tenantId: string
let host: string
let spaceId: string
let noindexPageId: string
let indexablePageId: string

async function mkPage(noindex: boolean): Promise<string> {
  const [{ id }] = await admin<[{ id: string }]>`
    INSERT INTO pages (tenant_id, space_id, title, noindex) VALUES (${tenantId}, ${spaceId}, 'P', ${noindex}) RETURNING id`
  await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${id}` }])
  return id
}

beforeAll(async () => {
  const slug = `noidx-${Date.now().toString(36)}`
  host = `${slug}.localhost`
  ;({ tenantId } = await provisionTenant(fgaClient, { slug, admin: { sub: 'noidx-owner' } }))
  ;[{ id: spaceId }] = await admin<[{ id: string }]>`
    INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, 'noidx-space') RETURNING id`
  noindexPageId = await mkPage(true)
  indexablePageId = await mkPage(false)
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  for (const id of [noindexPageId, indexablePageId]) {
    await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${id}` }]).catch(() => {})
  }
  await admin`DELETE FROM pages WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#124 public noindex → X-Robots-Tag header', () => {
  it('sets X-Robots-Tag: noindex on a noindex public page', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/pages/${noindexPageId}`, headers: { host } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.json()).toMatchObject({ noindex: true })
  })

  it('does NOT set X-Robots-Tag on an indexable public page', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/pages/${indexablePageId}`, headers: { host } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-robots-tag']).toBeUndefined()
    expect(res.json()).toMatchObject({ noindex: false })
  })
})
