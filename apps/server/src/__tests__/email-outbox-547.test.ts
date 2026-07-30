// #547 / ADR-196 §5 (S1): the email outbox infrastructure. Rows are thin (no content); the drain
// resolves tenant + address at SEND time, builds through the per-class builder registry, folds
// siblings by key, retries with the webhook backoff shape, and DROPS (with a logged reason) anything
// that could poison the queue head (#482): unknown class, tenant gone, member gone/deactivated/
// address-less. Address resolution is (tenant_id, sub)-scoped — a same-sub member in another tenant
// must never receive the mail (the global no-RLS queue's cross-tenant pin, named in the review
// ruling).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { registerEmailBuilder, drainEmailOutbox, enqueueEmailOutbox, type EmailOutboxRow } from '../email/outbox.js'
import type { EmailMessage } from '@wikistead/hooks'
import { registerEmailDriver, registerEmailDriverResolver } from '@wikistead/hooks'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const T1 = 'tenant_dev'
const T2 = 'tenant_acme'
const SUB = `eo-${STAMP}` // the SAME sub exists in both tenants with different addresses

let sent: (EmailMessage & { via?: string })[] = []
const logs: string[] = []
const fallback = { send: async (m: EmailMessage) => { sent.push({ ...m, via: 'fallback' }) } }

beforeAll(async () => {
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${T1}, ${SUB}, 'EO One', ${`${SUB}@one.test`})`
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${T2}, ${SUB}, 'EO Two', ${`${SUB}@two.test`})`
  registerEmailBuilder(`eo-test-${STAMP}`, async (rows) => ({
    kind: 'send',
    message: { subject: `s1-${rows.length}`, text: 't', html: '<p>t</p>' },
  }))
  registerEmailBuilder(`eo-skip-${STAMP}`, async () => ({ kind: 'skip', reason: 'suppressed by test' }))
}, 60_000)

afterAll(async () => {
  await adminPool`DELETE FROM email_outbox WHERE member_sub = ${SUB}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${SUB}`.catch(() => {})
  await adminPool.end(); await pool.end()
}, 60_000)

beforeEach(() => {
  sent = []
  logs.length = 0
  registerEmailDriverResolver(() => null)
  // @ts-expect-error deliberate reset of the boot-time slot
  registerEmailDriver(null)
})

const drain = () => drainEmailOutbox({ fallback, log: (m) => logs.push(m), batch: 50 })
const rowsInQueue = () => adminPool<{ id: string }[]>`SELECT id FROM email_outbox WHERE member_sub = ${SUB}`

describe('#547 S1: email outbox infrastructure', () => {
  it('sends through the builder to the TENANT-SCOPED address, and the queue empties', async () => {
    await enqueueEmailOutbox([{ tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}` }])
    await drain()
    expect(sent.length).toBe(1)
    expect(sent[0]!.to, 'the address is the (tenant, sub) row — not the same sub in another tenant').toBe(`${SUB}@one.test`)
    expect(sent[0]!.subject).toBe('s1-1')
    expect((await rowsInQueue()).length).toBe(0)
  }, 60_000)

  it('folds due siblings with one key into ONE message', async () => {
    const fold = `fk-${STAMP}`
    await enqueueEmailOutbox([
      { tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}`, foldKey: fold },
      { tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}`, foldKey: fold },
      { tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}`, foldKey: fold },
    ])
    await drain()
    expect(sent.length, 'K rows, one message').toBe(1)
    expect(sent[0]!.subject, 'the builder saw the whole fold group').toBe('s1-3')
    expect((await rowsInQueue()).length).toBe(0)
  }, 60_000)

  it('a builder skip (suppress) drops the rows without sending', async () => {
    await enqueueEmailOutbox([{ tenantId: T1, memberSub: SUB, class: `eo-skip-${STAMP}` }])
    await drain()
    expect(sent.length).toBe(0)
    expect((await rowsInQueue()).length).toBe(0)
    expect(logs.some((l) => l.includes('suppressed by test'))).toBe(true)
  }, 60_000)

  it('poison rows drop immediately with a logged reason: unknown class / tenant gone / no address', async () => {
    await enqueueEmailOutbox([
      { tenantId: T1, memberSub: SUB, class: `eo-nobody-${STAMP}` },
      { tenantId: `ghost-${STAMP}`, memberSub: SUB, class: `eo-test-${STAMP}` },
    ])
    await adminPool`UPDATE members SET email = NULL WHERE tenant_id = ${T2} AND sub = ${SUB}`
    await enqueueEmailOutbox([{ tenantId: T2, memberSub: SUB, class: `eo-test-${STAMP}` }])
    await drain()
    expect(sent.length).toBe(0)
    expect((await rowsInQueue()).length, 'nothing lingers to poison the head').toBe(0)
    expect(logs.some((l) => l.includes('no builder'))).toBe(true)
    expect(logs.some((l) => l.includes('tenant gone'))).toBe(true)
    expect(logs.some((l) => l.includes('no address'))).toBe(true)
  }, 60_000)

  it('a send failure retries with backoff (attempts grows, row stays)', async () => {
    const failing = { send: async () => { throw new Error('smtp down') } }
    await enqueueEmailOutbox([{ tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}` }])
    await drainEmailOutbox({ fallback: failing, log: (m) => logs.push(m), batch: 50 })
    const left = await adminPool<EmailOutboxRow[]>`SELECT id, attempts FROM email_outbox WHERE member_sub = ${SUB}`
    expect(left.length, 'the row survived for retry').toBe(1)
    expect(left[0]!.attempts).toBe(1)
    await adminPool`DELETE FROM email_outbox WHERE member_sub = ${SUB}`
  }, 60_000)

  it('the per-tenant resolver picks the transport for the drain too (ADR-196 §7)', async () => {
    const managed: (EmailMessage & { via?: string })[] = []
    registerEmailDriverResolver((ctx) => (ctx.tenantId === T1 ? { send: async (m) => { managed.push({ ...m, via: 'managed' }) } } : null))
    await enqueueEmailOutbox([{ tenantId: T1, memberSub: SUB, class: `eo-test-${STAMP}` }])
    await drain()
    expect(managed.length, 'the resolver-provided driver carried the mail').toBe(1)
    expect(sent.length, 'the fallback did not').toBe(0)
  }, 60_000)
})
