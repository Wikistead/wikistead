// Taking a page out of public view must not report success while anyone can still read it.
//
// `view_base`'s `[user:*]` arm is NOT `but not private` (model.fga): public⊥private holds at the WRITE
// boundary and nowhere else, and routes/public.ts authorises anonymous reads off that very tuple. So every
// path that removes the public grant is the only thing standing between "the caller pressed the button"
// and "the page is still world-readable" — and each of them swallowed EVERY failure, not just the harmless
// "it was not public anyway".
//
// Measured before the fix, with a store that refuses writes: unsetPagePublic returned normally, wrote
// `page.made_non_public` to the audit ledger, fired the webhook, and `check(user:anonymous, view, page)`
// was still true. The tests below assert on that check — the access itself — rather than on a status code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePublic, unsetPagePublic, setPagePrivate } from '../routes/pages.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
const pages: string[] = []

// A client that cannot write. This is what "the store is unavailable" or "the model moved" looks like from
// inside a route — the case the swallows turned into success.
const refusing = () => Object.assign(Object.create(Object.getPrototypeOf(fgaClient) as object), fgaClient, {
  write: async () => { throw new Error('the permission store is unavailable') },
}) as typeof fgaClient

async function freshPublicPage(tag: string): Promise<string> {
  const { id } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-${tag}-${STAMP}` })
  pages.push(id)
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  await setPagePublic(db, fgaClient, app.searchDriver, { pageId: id, tenantId: TENANT, userId: OWNER, plan: 'business' })
  return id
}

const anyoneCanRead = (pageId: string) => check(fgaClient, 'user:anonymous', 'view', { type: 'page', id: pageId })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `pgr-${STAMP}` })).id
}, 180_000)

afterAll(async () => {
  for (const id of pages.reverse()) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  for (const id of pages) await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

async function auditCount(pageId: string): Promise<number> {
  await drainAuditFor(admin, TENANT)
  const [{ n }] = await admin<[{ n: string }]>`
    SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`page:${pageId}`}
      AND action IN ('page.made_non_public', 'page.made_private')`
  return Number(n)
}

async function eventsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const off = onDomainEvent((e) => { if (e.type === 'page.made_non_public' || e.type === 'page.made_private') seen.push(e.type) })
  try { await fn().catch(() => {}) } finally { off() }
  return seen
}

describe('a refused removal is not reported as a removal', () => {
  it('unsetPagePublic: the caller hears it, and the ledger is not written', async () => {
    const pageId = await freshPublicPage('unset')
    expect(await anyoneCanRead(pageId), 'public to begin with').toBe(true)
    const before = await auditCount(pageId)

    const events = await eventsDuring(() =>
      unsetPagePublic(db, refusing(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    expect(await anyoneCanRead(pageId), 'still public — that is the truth to report').toBe(true)
    expect(events, 'no event for a removal that did not happen').toEqual([])
    expect(await auditCount(pageId) - before, 'no audit line either').toBe(0)
    await expect(
      unsetPagePublic(db, refusing(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }),
      'and the call itself fails',
    ).rejects.toThrow()
  }, 180_000)

  it('setPagePrivate: a page whose grant survived does not pass as private', async () => {
    const pageId = await freshPublicPage('private')
    const before = await auditCount(pageId)

    const events = await eventsDuring(() =>
      setPagePrivate(db, refusing(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    // The marker write is refused too, so nothing landed — but the point is what is SAID about it.
    expect(events, 'no "made private" for a page anyone can still read').toEqual([])
    expect(await auditCount(pageId) - before, 'and nothing in the ledger').toBe(0)
  }, 180_000)

  it('the working path still works, and still says so', async () => {
    const pageId = await freshPublicPage('happy')
    const before = await auditCount(pageId)
    const events = await eventsDuring(() =>
      unsetPagePublic(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    expect(await anyoneCanRead(pageId), 'the grant really went').toBe(false)
    expect(events, 'and the event fires — silence on success would be the opposite defect').toEqual(['page.made_non_public'])
    expect(await auditCount(pageId) - before, 'with its ledger line').toBe(1)
  }, 180_000)

  it('removing a grant that was never there still succeeds (convergence is not failure)', async () => {
    const { id } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-never-${STAMP}` })
    pages.push(id)
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
    await expect(
      unsetPagePublic(db, fgaClient, app.searchDriver, { pageId: id, tenantId: TENANT, userId: OWNER, plan: 'business' }),
    ).resolves.toBeUndefined()
  }, 180_000)
})

describe('every path that removes the public grant, found rather than listed', () => {
  it('no site swallows the whole failure', () => {
    // The defect was four copies of one line, and naming them would not catch the fifth. Walk the routes
    // instead: any delete of PUBLIC_GRANT must either let a refusal through or filter it with
    // isAlreadyConverged — a bare `.catch(() => {})` there is the leak this file exists for.
    const file = resolve(import.meta.dirname, '../routes/pages.ts')
    const lines = readFileSync(file, 'utf8').split('\n')
    const offenders = lines
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /deleteTuples\([^)]*PUBLIC_GRANT/.test(line))
      .filter(({ line }) => /\.catch\(\s*\(\s*\)\s*=>/.test(line)) // a catch that ignores its argument
    expect(offenders, 'these report success no matter what the store said').toEqual([])
    // …and the sweep is not vacuous: the sites exist.
    expect(lines.filter((l) => /deleteTuples\([^)]*PUBLIC_GRANT/.test(l)).length).toBeGreaterThanOrEqual(4)
  })
})
