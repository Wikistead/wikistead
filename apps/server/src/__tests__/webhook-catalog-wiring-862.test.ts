// #862 / ADR-108 Q4: the catalogue is a promise, and this measures that the wiring keeps it.
//
// The generated reference lists 76 event types and says webhooks are built on them. Two were actually
// delivered — each because one call site remembered to enqueue by hand — and the other 74 were emitted
// onto the in-process bus with nobody listening. The existing suite could not see it: `webhooks-228`
// calls `enqueueWebhookOutbox` itself and then asserts the row arrives, which measures the outbox and
// says nothing about whether anything puts events into it.
//
// So these walk the OTHER direction: start from the catalogue, go through the bridge, and ask what
// comes out.
//
// ⚠️ WHICH ENTRYPOINTS THIS SPEAKS FOR. The live walk goes through `buildApp`, so it measures the
// API server process and only that one. It cannot say anything about a type emitted from a CLI or a
// cron — the bridge subscribes inside `buildApp`, so those emits reach nobody. Three such types were
// ruled out of egress entirely (§C); the fourth, `orphan_draft.claim_expired`, enqueues at its own
// call site now, and the walk below checks the source rather than driving the sweep.
//
// ⚠️ These walks do NOT cover a type added tomorrow, and this header used to claim they did (#862
// measured it: adding a fictional type to the catalogue left all six green). Only one type is
// actually driven through a live outbox here; the rest are read from the catalogue and asked a
// question the bridge answers without a database. What DOES cover a new type is `egress.ts`'s
// `Record<DomainEvent['type'], EgressVerdict>` — an unruled type fails `pnpm typecheck`, which is a
// stronger gate than a test but a different one, and saying so is the point of this note.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { EVENT_CATALOG, emit } from '@wikistead/events'
import type { DomainEvent } from '@wikistead/events'
import { buildApp } from '../app.js'
import { bridgeShouldEnqueue, webhookPayload, ENQUEUED_IN_TRANSACTION } from '../webhooks/bridge.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const countRows = async (): Promise<number> =>
  (await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE tenant_id = ${TENANT}`)[0]!.n

afterAll(async () => { await admin.end() })

/** A minimal event of the given type — the bridge only reads `type` and `tenantId`. */
const eventOf = (type: string): DomainEvent =>
  ({ type, tenantId: 'tenant_dev', pageId: 'p1', actorId: 'user-1' }) as unknown as DomainEvent

const catalogued = Object.keys(EVENT_CATALOG)

describe('#862 §F — the per-request auth events write nothing', () => {
  it('a real request with a garbage bearer leaves no outbox row', async () => {
    // ⚠️ This is §F's measurement turned into an assertion, and it is measured through a REQUEST, not
    // through `emit`. `resolvePrincipal` raises `auth.failed` from a dozen places on the onRequest
    // hook, and reaching one costs a malformed `Authorization` header — no share link, no key, no
    // account. Before the ruling, that header was one INSERT into a durable table, and 17 of 21 rows
    // after an ordinary run were `auth.success`. The bridge does not consult whether the tenant has a
    // hook, so a tenant with none paid for the writes too.
    const app = await buildApp()
    try {
      await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${TENANT}`
      const before = await countRows()
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: 'GET', url: '/spaces', headers: { host: 'dev.localhost', authorization: `Bearer not-a-real-token-${i}` } })
      }
      // the bus hands the bridge its handlers through a resolved promise — give them room to land
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25))
      expect(await countRows(), 'five refused requests wrote nothing to the outbox').toBe(before)
      const auth = await admin<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE event_type LIKE 'auth.%'`
      expect(auth[0]!.n, 'and no auth row exists for any tenant').toBe(0)
    } finally {
      await app.close()
    }
  }, 120_000)
})

describe('#862 every catalogued event reaches the webhook outbox', () => {
  it('the catalogue is not empty (a walk that finds nothing would pass everything below)', () => {
    expect(catalogued.length, 'the event catalogue is empty — this file is measuring nothing').toBeGreaterThan(50)
  })

  it('the app really subscribes the bridge — an emitted event lands in the outbox', async () => {
    // The assertions around this one measure the RULE. This one measures the WIRING, which is the half
    // that was missing: `bridgeShouldEnqueue` answering true proves nothing if nobody calls it. An
    // earlier version of this file asserted "every catalogued type is bridged or enqueued", which the
    // bridge's own default makes true for any type at all — measured, and it stayed green when a made-up
    // type was added to the catalogue. So this goes through buildApp, emits, and reads the table.
    const app = await buildApp()
    try {
      const before = await countRows()
      emit({ type: 'page.renamed', tenantId: TENANT, pageId: 'wiring-862', actorId: 'user-1' })
      // the bridge is async by contract (the bus does not await its handlers)
      await expect.poll(async () => (await countRows()) - before, { timeout: 5_000 }).toBeGreaterThan(0)
      const [row] = await admin<{ event_type: string; payload: { pageId?: string } }[]>`
        SELECT event_type, payload FROM webhook_outbox
         WHERE tenant_id = ${TENANT} AND payload->>'pageId' = 'wiring-862' LIMIT 1`
      expect(row?.event_type, 'the row names the event that was emitted').toBe('page.renamed')
      expect(row?.payload.pageId).toBe('wiring-862')
    } finally {
      await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${TENANT} AND payload->>'pageId' = 'wiring-862'`
      await app.close()
    }
  }, 60_000)

  it('the bridge skips exactly the types it is meant to, and no others', () => {
    // Not "skips some things": skipping one nothing else carries would silently drop it, and skipping
    // nothing would deliver the published event twice.
    //
    // Two reasons a type is skipped, and they are unrelated. A transaction-scoped call site already
    // enqueues it — that set is `ENQUEUED_IN_TRANSACTION`, and the walk below checks the code really
    // does. Or it was ruled out of egress entirely (ADR-108 addendum §C/§F, 2026-08-22), and those five
    // are NAMED HERE rather than read back from `egress.ts`: deriving the expectation from the same
    // table `bridgeShouldEnqueue` consults would make this assertion agree with itself, and a verdict
    // flipped by accident would keep it green. Written out, flipping one shows up as a diff.
    const RULED_OUT = [
      'auth.success', // §F — emitted per request; reachable with any bearer, so it is write amplification
      'auth.failed',
      'tenant.oidc_recovered', // §C — carries the Wikistead operator's identifier (ADR-169: never that)
      'tenant.login_methods_recovered',
      'tenant.saml_recovered',
    ] as const
    const skipped = catalogued.filter((type) => !bridgeShouldEnqueue(eventOf(type)))
    expect(skipped.sort()).toEqual([...ENQUEUED_IN_TRANSACTION, ...RULED_OUT].sort())
  })

  it('every skipped type is one the code really does enqueue in a transaction', async () => {
    // The set above is a claim about OTHER files. If a publish path stops enqueueing, or is renamed,
    // this set becomes a hole that reads like a deliberate exclusion — so the claim is checked against
    // the source rather than trusted.
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
    const sources = ['src/routes/pages.ts', 'src/routes/api-keys.ts', 'src/scripts/orphan-claim-sweep.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
    for (const type of ENQUEUED_IN_TRANSACTION) {
      expect(
        new RegExp(`enqueueWebhookOutbox\\([\\s\\S]{0,200}?${type.replace('.', '\\.')}`).test(sources),
        `${type} is skipped by the bridge, so some call site must enqueue it inside a transaction`,
      ).toBe(true)
    }
  })

  it('the delivered payload carries the event, without repeating what the row already holds', () => {
    const payload = webhookPayload({
      type: 'page.renamed', tenantId: 'tenant_dev', pageId: 'p1', actorId: 'user-1',
    } as DomainEvent)
    expect(payload.pageId).toBe('p1')
    expect(payload.actorId).toBe('user-1')
    expect(payload.occurredAt, 'a subscriber needs to know when').toBeTruthy()
    // `type` and `tenantId` are columns of `webhook_outbox`; repeating them invites two answers.
    expect(payload).not.toHaveProperty('type')
    expect(payload).not.toHaveProperty('tenantId')
  })

  it('the renamed and moved events exist, and the type that lied about both is gone', () => {
    // #853: `page.updated` fired on a rename and a move and never on a body change. Split while
    // nothing was delivered, so no subscriber could be broken by it.
    expect(catalogued).toContain('page.renamed')
    expect(catalogued).toContain('page.moved')
    expect(catalogued, 'the name that described neither is gone').not.toContain('page.updated')
  })
})
