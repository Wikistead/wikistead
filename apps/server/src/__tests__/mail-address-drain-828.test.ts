// Integration — real Postgres. #828 / ADR-254 Decision 5, second half: the addressing failure is
// reported ONCE PER DRAIN, not once per message.
//
// ⚠️ Why that half needs its own pin. In a drain of twenty messages the cause is the same twenty
// times, and a log that repeats it reads as twenty problems — which is how an operator concludes the
// mail system is broken in twenty ways and stops reading. The ADR says "once per drain rather than
// once per message" in as many words, and nothing about the per-message drop lines can show whether
// that holds: only counting the lines can.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { enqueueEmailOutbox, registerEmailBuilder, drainEmailOutbox } from '../email/outbox.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const SUB = `m828-${STAMP}`
const CLASS = `t828-${STAMP}`
const noop = { send: async () => {} }

// A builder that always skips: this pin is about the ADDRESSING line, not about any delivery class.
// Registering our own keeps mention/digest internals out of it.
registerEmailBuilder(CLASS, async () => ({ kind: 'skip', reason: 'this pin never sends' }))

let saved: string | undefined
let slug = ''

beforeAll(async () => {
  saved = process.env.WKS_PUBLIC_BASE_URL
  delete process.env.WKS_PUBLIC_BASE_URL // the state the ADR is about: no address can be composed
  await admin`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${T}, ${SUB}, ${SUB}, ${`${SUB}@t.test`})`
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${T}`.catch(() => {})
  slug = (await admin<{ slug: string }[]>`SELECT slug FROM tenants WHERE id = ${T}`)[0]!.slug
})

afterAll(async () => {
  if (saved === undefined) delete process.env.WKS_PUBLIC_BASE_URL
  else process.env.WKS_PUBLIC_BASE_URL = saved
  await admin`DELETE FROM email_outbox WHERE tenant_id = ${T} AND member_sub = ${SUB}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${SUB}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#828 the drain explains the address once', () => {
  it('three unaddressable messages produce one explanation, and it names the step', async () => {
    // #1057: the drain claims EVERY pending row on the shared stack, not just this file's, and
    // `handled` below counts what it claimed. A row another test left behind (measured: 4 for 3 on
    // the CE build's full suite, green in isolation) is not this pin's subject — consume whatever
    // is pending first, so the count and the once-per-drain line are judged on these three alone.
    await drainEmailOutbox({ fallback: noop, batch: 500 })
    await enqueueEmailOutbox([1, 2, 3].map(() => ({ tenantId: T, memberSub: SUB, class: CLASS })))
    const lines: string[] = []
    const handled = await drainEmailOutbox({ fallback: noop, log: (m) => lines.push(m), batch: 50 })
    expect(handled, 'the drain did not reach these rows at all').toBe(3)

    const addressing = lines.filter((l) => l.includes('has no address for links'))
    expect(addressing.length, `the explanation repeated per message:\n${lines.join('\n')}`).toBe(1)
    expect(addressing[0], 'the line does not say WHICH step ran out')
      .toContain('no verified custom domain, no WKS_PUBLIC_BASE_URL, so no link')
    // The SLUG, not the id: it is what an operator types and what the address would have been built
    // from. Read from the row rather than written here, so the pin cannot drift from the fixture.
    expect(addressing[0], 'the line does not say WHICH workspace').toContain(slug)

    // ⚠️ And the rows still each got their own drop line: the once-per-drain rule is about the
    // DIAGNOSIS, not about the record of what happened to each message. A version that deduplicated
    // the drops too would lose the audit of which messages died.
    expect(lines.filter((l) => l.startsWith('email outbox drop')).length, 'per-message drops were deduplicated away').toBe(3)
  }, 60_000)
})
