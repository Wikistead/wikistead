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
import { EVENT_CATALOG, registerActorKeyResolver, resetActorKeyResolver } from '@wikistead/events'
import type { DomainEvent } from '@wikistead/events'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { EGRESS, egressVerdict } from '../webhooks/egress.js'
import { pageEventDisposition } from '../page-disposition.js'
import { fgaClient } from '@wikistead/authz'
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
    // it shows. The numbers are the rulings of 2026-08-22 and, for the last three, 2026-08-27 (§K).
    expect(by('drop'), 'the three operator events and both auth events').toBe(5)
    // #1019 / ADR-108 §M (2026-09-03): the two password-reset events moved from `redact` to `send` —
    // 6 → 4. member.locked and the orphan-draft trio are unchanged.
    expect(by('redact'), 'member.locked and the orphan-draft trio').toBe(4)
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

describe('#862 §K — the orphan-draft trio ships without the page id', () => {
  const TRIO = ['orphan_draft.claimed', 'orphan_draft.reassigned', 'orphan_draft.claim_expired'] as const
  const everything = {
    pageId: 'page-k862', actorId: 'admin-1', adminSub: 'admin-1', newOwner: 'user:someone',
    expiresAt: '2026-01-01T00:00:00.000Z', occurredAt: '2026-01-01T00:00:00.000Z',
  }

  it('all three withhold the page id, and the row is still written', async () => {
    for (const type of TRIO) {
      expect(egressVerdict(type).kind, type).toBe('redact')
      const payload = await storedPayload(type, everything)
      expect(payload, `${type}: the row is written; only the field is withheld`).not.toBeNull()
      expect(payload, type).not.toHaveProperty('pageId')
      expect(payload!.occurredAt, `${type}: the consumer still learns when`).toBeTruthy()
    }
  })

  // ⚠️ The point of §K is not tidiness. `pageEventDisposition` reads `payload.pageId`, and an orphan
  // draft is unpublished by definition — no `page#space` tuple — so while the id was in the row the
  // answer was `not-ready` every time: six retries, then dropped. The table said `ship` and nothing
  // ever shipped. Withholding the id is what takes these out of a gate they could never pass.
  it('⚠️ and that is what makes them deliverable at all', async () => {
    const payload = await storedPayload('orphan_draft.claimed', everything)
    expect(await pageEventDisposition(fgaClient, payload!), 'no page id in the row → not a page event').toBe('deliver')
  })

  // Without this, an implementation that stripped `pageId` from EVERY type would pass the case above.
  // The same unpublished id, on a type whose row still names it, is still gated.
  it('⚠️ and the strip is scoped to the trio — a page event with the same id is still gated', async () => {
    const gated = await storedPayload('page.renamed', { pageId: 'page-k862', actorId: 'admin-1' })
    expect(gated, 'page.renamed still carries its page id').toHaveProperty('pageId')
    expect(await pageEventDisposition(fgaClient, gated!), 'an unlinked page is not deliverable').not.toBe('deliver')
  })
})

describe('#862 §M (#1019) — the reset events ship their subject like every sibling; the lockout still does not', () => {
  it('the reset events carry the window AND whose window it is', async () => {
    // §E's strip on these two is RETRACTED (ADR-108 §M, 2026-09-03) — the ruling that stripped them
    // contradicted its own reasoning (member.factors_reset ships targetSub for the same "timing-sharp"
    // class of fact). They now ship like `member.password_changed` / `member.factor_removed` / etc.
    for (const type of ['member.password_reset_requested', 'member.password_reset_completed'] as const) {
      expect(egressVerdict(type).kind, type).toBe('send')
      const payload = await storedPayload(type, { targetSub: 'user-42', actorId: 'admin-1', occurredAt: '2026-01-01T00:00:00.000Z' })
      expect(payload, `${type}: the row is written`).not.toBeNull()
      expect(payload, type).toHaveProperty('targetSub', 'user-42')
    }
  })

  // §L finding 2 (a conditional targetSub on member.locked when the identifier resolved) was REFUSED,
  // not accepted — kept in the SAME describe block as the reset-events reversal above, on purpose: a
  // future edit that fixes one by loosening the other fails here, not just in §D's own separate block.
  it('⚠️ …and member.locked still withholds the identifier — fixing one must not loosen the other', async () => {
    expect(egressVerdict('member.locked').kind).toBe('redact')
    // review finding (independent verification of this ticket): §L finding 2 proposed sending
    // `targetSub` from THIS type when the identifier happened to resolve — so the input here MUST
    // supply one, or a landed finding-2-shaped change (egress row grows a `targetSub` entry, emit
    // site starts passing it) would sail through this assertion having never been exercised.
    const payload = await storedPayload('member.locked', { identifier: 'victim@example.com', targetSub: 'user-42', occurredAt: '2026-01-01T00:00:00.000Z' })
    expect(payload, 'the row is written; only the field is withheld').not.toBeNull()
    expect(payload).not.toHaveProperty('identifier')
    expect(payload).not.toHaveProperty('targetSub')
    // The allow-list itself, not just the two fields this ticket cares about — catches any other
    // field a future edit might add to this row without a matching ruling.
    expect(Object.keys(payload!).sort()).toEqual(['occurredAt'])
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

  it('⚠️ every road stamps `occurredAt`, including the ones that skip the bridge', async () => {
    // finding 4: this used to be stamped in the bridge, so the two transaction-scoped call sites
    // and the CLI one wrote rows with no timestamp — while their rows named the field, which made the
    // generated reference promise something the wire did not carry.
    for (const type of ['api_key.revoked', 'orphan_draft.claim_expired'] as const) {
      const payload = await storedPayload(type, type === 'api_key.revoked'
        ? { keyId: 'k1', actorId: 'admin-1', ownerId: 'member-1' }
        : { pageId: 'p1', adminSub: 'admin-1' })
      expect(payload!.occurredAt, `${type} carries when it happened`).toBeTruthy()
    }
  })

  it('⚠️ and the key the actor arrived on, on the roads that never see the bus', async () => {
    // finding 4: `page.published` through the bridge carried `actorKeyId` because `emit` adds it,
    // and the same event through the publish path did not — so ADR-221 §9 held or not depending on
    // which road the event took. The stamp is at the write now, and it asks the SAME resolver `emit`
    // asks. Driven through the resolver rather than by putting the field in the payload: a walk that
    // hands the key in measures the allow-list, not the stamp, and the first version of this did that
    // and stayed green with the stamp deleted.
    registerActorKeyResolver(() => 'key-from-the-request')
    try {
      const payload = await storedPayload('page.published', { pageId: 'p1', revisionId: 'r1', actorId: 'u1' })
      expect(payload!.actorKeyId, 'the in-transaction publish path carries it too').toBe('key-from-the-request')
    } finally {
      resetActorKeyResolver()
    }
  })

  it('⚠️ and a caller that already named the key keeps theirs', async () => {
    // The stamp fills a gap; it does not overwrite. An event off the bus arrives with the key `emit`
    // put on it, and a second answer to the same question is how two answers start disagreeing.
    registerActorKeyResolver(() => 'the-ambient-one')
    try {
      const payload = await storedPayload('page.published', { pageId: 'p1', revisionId: 'r1', actorId: 'u1', actorKeyId: 'the-one-on-the-event' })
      expect(payload!.actorKeyId).toBe('the-one-on-the-event')
    } finally {
      resetActorKeyResolver()
    }
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

describe('#862 §N (#1068, ADR-278) — member.signed_in ships door unredacted, the operator identity never does', () => {
  it('ships targetSub AND door, for every door', async () => {
    // Ruled rounding `door` off would not reduce disclosure — `member.factor_enrolled` and
    // `member.factors_reset` already ship targetSub, so a consumer reconstructs the same "who has 2FA"
    // fact either way — and it would kill the one thing this event adds: a no-2FA sign-in visible as
    // it happens.
    for (const door of ['local', 'local+factor', 'federated', 'operator'] as const) {
      expect(egressVerdict('member.signed_in').kind).toBe('send')
      const payload = await storedPayload('member.signed_in', { actorId: 'user-42', targetSub: 'user-42', door, occurredAt: '2026-01-01T00:00:00.000Z' })
      expect(payload, 'the row is written').not.toBeNull()
      expect(payload).toHaveProperty('targetSub', 'user-42')
      expect(payload).toHaveProperty('door', door)
    }
  })

  // Condition 1 of the ruling: `door: 'operator'` may say a break-glass sign-in happened; no field on
  // this event may ever name WHICH operator. There is no `operatorId`/`operator` field in the union at
  // all — this asserts the allow-list itself, so a future edit that adds one without a matching ruling
  // is caught here rather than trusting the type to have stayed empty.
  it('⚠️ …and the operator door carries no operator identity, even if a caller tried to add one', async () => {
    const payload = await storedPayload('member.signed_in', {
      actorId: 'user-42', targetSub: 'user-42', door: 'operator', occurredAt: '2026-01-01T00:00:00.000Z',
      operator: 'alice', operatorId: 'alice', operatorSub: 'alice',
    })
    expect(payload, 'the row is written').not.toBeNull()
    expect(payload, 'the allow-list strips fields no row names, operator identity included').not.toHaveProperty('operator')
    expect(payload).not.toHaveProperty('operatorId')
    expect(payload).not.toHaveProperty('operatorSub')
    expect(Object.keys(payload!).sort()).toEqual(['door', 'occurredAt', 'targetSub'])
  })

  // The pin the ruling asked for: the egress-VERDICT difference between the two events that both name
  // a sign-in, not their catalog.ts prose (prose can drift without a test noticing; the verdict cannot).
  it('⚠️ and this is the field that actually separates it from auth.success — the verdict, not the description', () => {
    expect(egressVerdict('auth.success').kind, 'per-request auth pass: undelivered, §F').toBe('drop')
    expect(egressVerdict('member.signed_in').kind, 'session established: delivered').toBe('send')
  })
})
