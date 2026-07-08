// #228 / ADR-108: outbound webhooks. Security-critical (egress + existence-hiding). These anti-tests pin
// the load-bearing controls: https-only + entitlement gate at creation, the secret is encrypted at rest,
// events are enqueued IN the tx (crash-safe), a private/unpublished-draft page's event is NEVER delivered
// (dropped at drain), and delivery goes through the PINNED SSRF-safe client (a blocked URL fails and, after
// N failures, auto-disables the hook). Real Postgres + OpenFGA. (The 2xx happy-path delivery needs a real
// external receiver — the SSRF screen blocks localhost — so it is a review/needs-human-check item.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { createWebhook, listWebhooks, enqueueWebhookOutbox, drainWebhookOutbox } from '../routes/webhooks.js'
import { decryptSecret } from '../auth/secret-crypto.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, spaceId: string, pubPage: string, privPage: string
const hookIds: string[] = []

async function outboxCount(tenantId: string): Promise<number> {
  const [r] = await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE tenant_id = ${tenantId}`
  return r!.n
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'wh-space' })).id
  pubPage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Published' })).id
  privPage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Private' })).id
  await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}` // clear any rows leaked by a prior crashed run (shared dev tenant; outboxCount asserts are tenant-wide)
  await admin`UPDATE pages SET published_at = now() WHERE id IN (${pubPage}, ${privPage})`
  await writeTuples(fgaClient, [
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pubPage}` }, // published/linked → deliverable
    { user: `space:${spaceId}`, relation: 'space', object: `page:${privPage}` },
    { user: 'user:*', relation: 'private', object: `page:${privPage}` }, // private → NOT deliverable
    { user: 'share_link:*', relation: 'private', object: `page:${privPage}` },
  ])
}, 60_000)

afterAll(async () => {
  for (const id of hookIds) await admin`DELETE FROM webhooks WHERE id = ${id}`.catch(() => {})
  await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 60_000)

describe('#228 createWebhook (creation gate)', () => {
  it('rejects a non-https url, stores the secret ENCRYPTED, returns it exactly once', async () => {
    await expect(createWebhook(db, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', url: 'http://example.com/hook' }))
      .rejects.toMatchObject({ statusCode: 400 })
    const { id, secret } = await createWebhook(db, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', url: 'https://example.com/hook' })
    hookIds.push(id)
    expect(secret).toBeTruthy()
    const [row] = await admin<{ secret_enc: string }[]>`SELECT secret_enc FROM webhooks WHERE id = ${id}`
    expect(row!.secret_enc).not.toBe(secret) // encrypted at rest, not plaintext
    expect(decryptSecret(row!.secret_enc)).toBe(secret) // round-trips to the returned secret
    // the LIST never exposes the secret (no secret/secret_enc field).
    const list = await listWebhooks(db)
    expect(Object.keys(list[0]!)).not.toContain('secret_enc')
    expect(Object.keys(list[0]!)).not.toContain('secret')
  })
})

describe('#228 enqueueWebhookOutbox (in-tx reliability)', () => {
  it('a rolled-back tx enqueues NO outbox row (crash-safe by construction)', async () => {
    const before = await outboxCount(tenant.id)
    await db.tx(async (tx) => {
      await enqueueWebhookOutbox(tx, { tenantId: tenant.id, eventType: 'page.published', payload: { pageId: pubPage } })
      throw new Error('rollback') // the enqueue must roll back with the operation
    }).catch(() => {})
    expect(await outboxCount(tenant.id)).toBe(before)
  })
})

describe('#228 drain — existence-hiding + SSRF', () => {
  it('DROPS a private-page event without delivering (instance-level existence-hiding)', async () => {
    // a hook exists (blocked url — but it must never even be attempted for a private page).
    const { id } = await createWebhook(db, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', url: 'https://127.0.0.1/hook' })
    hookIds.push(id)
    await db.tx((tx) => enqueueWebhookOutbox(tx, { tenantId: tenant.id, eventType: 'page.made_private', payload: { pageId: privPage } }))
    await drainWebhookOutbox(fgaClient)
    expect(await outboxCount(tenant.id)).toBe(0) // the private-page row was dropped (not retried)
    const [hook] = await admin<{ failure_count: number }[]>`SELECT failure_count FROM webhooks WHERE id = ${id}`
    expect(hook!.failure_count).toBe(0) // NO delivery attempt → no failure bump (never reached the URL)
  })

  it('RETRIES (does not drop) a page.published whose page#space link has not landed yet (#228 review 指摘2)', async () => {
    // A page published but NOT yet space-linked (the FGA page#space write lands just AFTER the publish tx, so
    // the outbox row can briefly out-race it) and NOT private → 'not-ready'. It must be rescheduled, never
    // permanently dropped, and never delivered while unlinked.
    const notLinked = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'RacePending' })).id
    await admin`UPDATE pages SET published_at = now() WHERE id = ${notLinked}` // no page#space tuple, no private marker
    const { id } = await createWebhook(db, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', url: 'https://127.0.0.1/hook' })
    hookIds.push(id)
    await db.tx((tx) => enqueueWebhookOutbox(tx, { tenantId: tenant.id, eventType: 'page.published', payload: { pageId: notLinked } }))
    await drainWebhookOutbox(fgaClient)
    const rows = await admin<{ attempts: number; next_attempt_at: Date }[]>`SELECT attempts, next_attempt_at FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    expect(rows.length).toBe(1) // retried, NOT dropped
    expect(rows[0]!.attempts).toBe(1) // one attempt burned, rescheduled with backoff
    expect(rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now()) // future (backoff), not due
    const [hook] = await admin<{ failure_count: number }[]>`SELECT failure_count FROM webhooks WHERE id = ${id}`
    expect(hook!.failure_count).toBe(0) // never delivered → no failure bump
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
  })

  it('a blocked (SSRF) delivery URL fails and, after N failures, auto-disables the hook', async () => {
    const { id } = await createWebhook(db, { tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user', url: 'https://127.0.0.1/blocked' })
    hookIds.push(id)
    // A PUBLISHED page event IS deliverable → the drain attempts the URL → the pinned SSRF client blocks
    // 127.0.0.1 → failure. Drive it past the auto-disable threshold (re-enqueue + drain repeatedly, forcing
    // next_attempt_at to now so backoff doesn't stall the test).
    for (let i = 0; i < 10; i++) {
      await db.tx((tx) => enqueueWebhookOutbox(tx, { tenantId: tenant.id, eventType: 'page.published', payload: { pageId: pubPage } }))
      await admin`UPDATE webhook_outbox SET next_attempt_at = now() WHERE tenant_id = ${tenant.id}`
      await drainWebhookOutbox(fgaClient)
    }
    const [hook] = await admin<{ active: boolean; failure_count: number }[]>`SELECT active, failure_count FROM webhooks WHERE id = ${id}`
    expect(hook!.failure_count).toBeGreaterThan(0) // the blocked URL never succeeded
    expect(hook!.active).toBe(false) // auto-disabled after the consecutive failures
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}` // tidy leftover rescheduled rows
  })
})
