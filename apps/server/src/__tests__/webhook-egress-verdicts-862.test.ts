// #862 / ADR-108 addendum: what leaves the tenant is decided per type, and the decisions are kept.
//
// The wiring landed carrying everything the catalogue holds, and nobody had read the payloads. Fifty
// of the seventy-six types reach a tenant-controlled URL with no per-instance authorization check at
// all, and four of those payloads reversed or stretched something already decided. The owner ruled on
// 2026-08-22; these are the rulings as assertions.
//
// ⚠️ What makes the table a gate rather than a list is the TYPE — `Record<DomainEvent['type'], …>`
// does not compile until a new event has a verdict. That is a compile error, which is the point: the
// suite here stayed green when a fictional type was added to the catalogue, and that blindness is how
// the operator-name events were shipped in the first place. These cases cover what a type cannot: that
// the verdicts are the ruled ones, and that the bridge obeys them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { EVENT_CATALOG } from '@wikistead/events'
import type { DomainEvent } from '@wikistead/events'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { EGRESS, egressVerdict } from '../webhooks/egress.js'
import { bridgeShouldEnqueue } from '../webhooks/bridge.js'
import { enqueueWebhookOutbox } from '../routes/webhooks.js'

const catalogued = Object.keys(EVENT_CATALOG) as DomainEvent['type'][]
const event = (type: string, rest: Record<string, unknown> = {}) =>
  ({ type, tenantId: 'tenant_dev', ...rest }) as unknown as DomainEvent

// ⚠️ The `strip` rulings are asserted on the ROW, not on what the bridge hands over. What the
// receiving system can read is the whole question, and there are three roads to a durable row — only
// one of them goes through the bridge. So these write through the real chokepoint and read back what
// Postgres holds.
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id} AND payload->>'egress862' IS NOT NULL`.catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 60_000)

/** Write one event through the durable chokepoint and return the payload the row actually holds. */
async function storedPayload(type: DomainEvent['type'], payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = await db.tx((tx) => enqueueWebhookOutbox(tx, { tenantId: tenant.id, eventType: type, payload }))
  if (id === null) return null
  const [row] = await admin<{ payload: Record<string, unknown> }[]>`SELECT payload FROM webhook_outbox WHERE id = ${id}`
  await admin`DELETE FROM webhook_outbox WHERE id = ${id}`
  return row!.payload
}

describe('#862 every catalogued type has a verdict', () => {
  it('the catalogue is not empty (a walk that finds nothing would pass everything below)', () => {
    expect(catalogued.length, 'the event catalogue is empty — this file is measuring nothing').toBeGreaterThan(50)
  })

  it('and the table covers exactly it — nothing missing, nothing extra', () => {
    // The type already guarantees this at compile time. Asserting it too is what makes a REMOVED
    // catalogue entry visible: deleting a type would leave a stale row that still compiles.
    expect(Object.keys(EGRESS).sort()).toEqual([...catalogued].sort())
    console.error(`#862: ${catalogued.length} catalogued type(s), ${Object.keys(EGRESS).length} verdict(s)`)
  })

  it('and the shape of the decision is legible — how many ship, how many do not', () => {
    const by = (k: string) => catalogued.filter((t) => egressVerdict(t).kind === k).length
    // Not a snapshot for its own sake: if a later change makes everything `send` again, this is where
    // it shows. The numbers are the 2026-08-22 rulings.
    expect(by('drop'), 'the three operator events and both auth events').toBe(5)
    expect(by('redact'), 'member.locked and the two password resets').toBe(3)
    expect(by('send') + by('drop') + by('redact')).toBe(catalogued.length)
  })
})

describe('#862 §C — a break-glass event never names the operator who ran it', () => {
  const OPERATOR_EVENTS = ['tenant.oidc_recovered', 'tenant.login_methods_recovered', 'tenant.saml_recovered'] as const

  it('all three are refused by the bridge', () => {
    for (const type of OPERATOR_EVENTS) {
      expect(egressVerdict(type).kind, type).toBe('drop')
      expect(bridgeShouldEnqueue(event(type, { operator: 'alice' })), `${type} must not reach the outbox`).toBe(false)
    }
  })

  it('⚠️ and the refusal is about the operator, not about the event', () => {
    // The reason is asserted because it is the thing a future reader will weigh. ADR-169 decided that
    // `vendor.access` — the event that exists to tell a tenant staff touched their data — carries the
    // action and never the person. These three say the same thing about the same act while naming
    // somebody, and they would reach a plan that cannot see the redacted feed at all.
    for (const type of OPERATOR_EVENTS) {
      const v = egressVerdict(type)
      expect(v.kind === 'drop' && v.why).toMatch(/operator id/)
    }
    expect(egressVerdict('vendor.access').kind, 'the redacted sibling still ships').toBe('send')
  })
})

describe('#862 §D — a lockout does not relay what the attacker typed', () => {
  it('ships, without the identifier', async () => {
    expect(egressVerdict('member.locked').kind).toBe('redact')
    const payload = await storedPayload('member.locked', { identifier: 'victim@example.com', occurredAt: '2026-01-01T00:00:00.000Z' })
    // ⚠️ The event still leaves: "an account was locked" is the operationally useful fact. What does
    // not leave is a string an unauthenticated caller chose — delivering it would make this product
    // POST attacker-supplied input to a URL the tenant configured.
    expect(payload, 'the row is written; only the field is withheld').not.toBeNull()
    expect(payload).not.toHaveProperty('identifier')
    expect(payload!.occurredAt, 'the consumer still learns when').toBeTruthy()
  })
})

describe('#862 §E — the security events ship; two lose their subject', () => {
  it('the reset events carry the window, not whose window it is', async () => {
    for (const type of ['member.password_reset_requested', 'member.password_reset_completed'] as const) {
      const payload = await storedPayload(type, { targetSub: 'user-42', actorId: 'admin-1', occurredAt: '2026-01-01T00:00:00.000Z' })
      expect(payload, `${type}: the row is written`).not.toBeNull()
      expect(payload, type).not.toHaveProperty('targetSub')
    }
  })

  it('⚠️ and the other security events are NOT dropped, because the ledger is not universal', () => {
    // The first reading called these redundant with the audit ledger. They are not: webhooks are
    // available from Personal upwards and the ledger is top-tier only, so on a hook-capable plan this
    // can be the tenant's only copy. Asserting `send` here is asserting that reasoning survived.
    for (const type of ['member.factor_removed', 'member.recovery_codes_minted', 'member.password_removed'] as const) {
      expect(egressVerdict(type).kind, type).toBe('send')
    }
  })
})

describe('#862 §F — neither auth event is bridged', () => {
  it('both are refused', () => {
    for (const type of ['auth.success', 'auth.failed'] as const) {
      expect(egressVerdict(type).kind, type).toBe('drop')
      expect(bridgeShouldEnqueue(event(type, { method: 'oidc' })), type).toBe(false)
    }
  })

  it('⚠️ because they are per-request and reachable without an account', () => {
    // Anonymous share-link editing is this product's centre, and every guest HTTP call carries a
    // bearer — so a keystroke flush, opening a page and fetching an attachment were each one outbox
    // INSERT. The bridge does not consult whether the tenant has a hook, so a tenant with none paid
    // the writes too, and a tenant with one would have made an outbound POST per request.
    for (const type of ['auth.success', 'auth.failed'] as const) {
      const v = egressVerdict(type)
      expect(v.kind === 'drop' && v.why).toMatch(/per request/)
    }
  })
})

describe('#862 the verdict is applied before the row is durable', () => {
  it('a withheld field is absent from the row Postgres holds', async () => {
    // Not at the drain: a row holding a field nobody may receive is the same disclosure one step
    // later, and the outbox outlives the request that wrote it.
    const payload = await storedPayload('member.locked', { identifier: 'x@example.com', occurredAt: '2026-01-01T00:00:00.000Z' })
    expect(Object.keys(payload!).sort()).toEqual(['occurredAt'])
  })

  it('⚠️ §H — a field the row does not name is dropped, not forwarded', async () => {
    // The payload used to be the event spread whole, so a field added to any type tomorrow left the
    // tenant that day. `egress862` is such a field: nothing in the catalogue declares it, and the
    // caller here asks for it to be sent.
    const payload = await storedPayload('page.created', { pageId: 'p1', spaceId: 's1', actorId: 'u1', egress862: 'must not travel' })
    expect(payload, 'the event still ships').not.toBeNull()
    expect(payload!.pageId, 'the fields its row names do travel').toBe('p1')
    expect(payload, 'a field no row names is dropped').not.toHaveProperty('egress862')
  })

  it('and a `send` verdict is not an excuse to drop the routing rule', async () => {
    // `type` and `tenantId` are columns of the row; repeating them in the payload invites two answers.
    const payload = await storedPayload('page.created', { pageId: 'p1', spaceId: 's1', actorId: 'u1', type: 'page.created', tenantId: tenant.id })
    expect(payload).not.toHaveProperty('type')
    expect(payload).not.toHaveProperty('tenantId')
    expect(payload!.pageId).toBe('p1')
  })

  it('⚠️ and `actorKeyId` still travels — ADR-221 §9 was not reversed by this change', async () => {
    // The field is distributed onto every event with an `actorId` by a conditional type, so no union
    // member declares it. A table of DECLARED fields would have stripped it from sixty events
    // silently, and §H's rule is exactly the thing that would have done the stripping. It is carried
    // because ADR-221 §9 says the key travels with the actor, for webhooks too.
    const payload = await storedPayload('page.created', { pageId: 'p1', actorId: 'u1', actorKeyId: 'key-1' })
    expect(payload!.actorKeyId, 'the key the actor arrived on').toBe('key-1')
  })

  it('⚠️ §F — a dropped type writes no row at all, by either road', async () => {
    // The bridge refuses it, and so does the chokepoint — because the two types that egress today do
    // not come through the bridge, and a refusal only the bridge performs would not cover them.
    for (const type of ['auth.success', 'auth.failed'] as const) {
      expect(bridgeShouldEnqueue(event(type, { method: 'oidc' })), `${type}: the bridge refuses`).toBe(false)
      expect(await storedPayload(type, { method: 'oidc' }), `${type}: and no row is written`).toBeNull()
    }
  })
})
