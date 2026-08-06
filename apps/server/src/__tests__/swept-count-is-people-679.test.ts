// #679 / ADR-222 §4: the number in the confirmation is people who will ACTUALLY be signed out.
//
// The dialog says "N will be signed out" before an admin narrows the stance. The set it is drawn from
// is everybody the new stance refuses — which includes people who are not signed in at all, and people
// signed in through an identity provider, whose session this sweep does not touch (the policy applies
// to the product's own doors; §3).
//
// So the count is not the size of that set. Saying "12 will be signed out" about eight people who were
// never signed in is not a rounding error: it is a number an admin weighs a decision on, and it makes
// the act look more disruptive than it is — which is how a safety confirmation ends up being clicked
// through without reading.
//
// Measured because nothing did. Replacing `countSweptSessions` with `subs.length` — count everybody,
// asked or not — left thirty-three assertions green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import IORedis from 'ioredis'
import { createSession, countSweptSessions, destroyMemberSessions, destroyUnsatisfiedSessions } from '../auth/session.js'

const valkey = new IORedis(process.env.VALKEY_URL || 'redis://localhost:6379')
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const sub = (name: string) => `cnt679-${name}-${STAMP}`
const ALL = ['none', 'local', 'twice', 'idp', 'answered'].map(sub)

afterAll(async () => {
  for (const s of ALL) await destroyMemberSessions(valkey, T, s).catch(() => {})
  await valkey.quit()
}, 60_000)

beforeAll(async () => {
  for (const s of ALL) await destroyMemberSessions(valkey, T, s).catch(() => {})
}, 60_000)

describe('#679: the number is people the sweep will actually sign out', () => {
  it('somebody who is not signed in is not counted', async () => {
    // The headline case: the set of "unsatisfied members" includes everybody the stance refuses,
    // whether or not they are here right now.
    expect(await countSweptSessions(valkey, T, [sub('none')]), 'counted somebody with no session at all')
      .toBe(0)
  }, 60_000)

  it('somebody signed in through the product IS counted, once', async () => {
    // The control that makes the case above a finding rather than "this function returns zero". And
    // ONCE: a person signed in on a laptop and a phone is one person being signed out, and the
    // sentence is about people.
    await createSession(valkey, { tenantId: T, sub: sub('local'), door: 'local' })
    expect(await countSweptSessions(valkey, T, [sub('local')])).toBe(1)

    await createSession(valkey, { tenantId: T, sub: sub('twice'), door: 'local' })
    await createSession(valkey, { tenantId: T, sub: sub('twice'), door: 'local' })
    expect(await countSweptSessions(valkey, T, [sub('twice')]), 'two sessions were counted as two people')
      .toBe(1)
  }, 60_000)

  it('a federated session is not counted — this policy is about the product’s own doors', async () => {
    // ADR-222 §3 / ADR-219 §3: a second factor is asked for at the doors this product owns. Somebody
    // whose session came from an identity provider keeps it, so counting them would promise a
    // sign-out that never happens.
    await createSession(valkey, { tenantId: T, sub: sub('idp'), door: 'federated' })
    expect(await countSweptSessions(valkey, T, [sub('idp')]), 'a federated session was counted as swept')
      .toBe(0)
  }, 60_000)

  it('a local session that already answered a factor is counted too — the KIND may have changed', async () => {
    // `local+factor` means they satisfied the old stance, not the new one. Narrowing is exactly the
    // case where somebody who answered yesterday is refused today, so excluding them would leave the
    // count silent about the people the change is actually about.
    await createSession(valkey, { tenantId: T, sub: sub('answered'), door: 'local+factor' })
    expect(await countSweptSessions(valkey, T, [sub('answered')]),
      'somebody who answered the OLD stance was left out of the count').toBe(1)
  }, 60_000)

  it('and the total is the sum of the people, not of the set handed in', async () => {
    // The shape the break took: `subs.length`. With four members and two of them actually signed in
    // through the product, the honest answer is two.
    expect(await countSweptSessions(valkey, T, ALL), 'the count was the size of the set, not the people in it')
      .toBe(3)
  }, 60_000)
})

// The sweep itself, not only the count. They must answer the same question — the number is shown to an
// admin deciding whether to narrow, and a sweep that takes a different set makes it a promise about a
// different act.
describe('#679: the sweep takes the sessions that answered the OLD stance', () => {
  const s2 = (name: string) => `sw679b-${name}-${STAMP}`
  const MINE = ['answered', 'plain', 'federated', 'operator'].map(s2)

  afterAll(async () => { for (const s of MINE) await destroyMemberSessions(valkey, T, s).catch(() => {}) }, 60_000)

  it('a `local+factor` session goes, because the KIND it answered is no longer accepted', async () => {
    // THE case. Somebody who signed in with an authenticator app under `any` holds `local+factor`.
    // Narrowing to `passkey` puts them in the unsatisfied set — and before this fix the door filter
    // dropped them again, leaving them signed in under a stance that refuses everything they hold.
    await createSession(valkey, { tenantId: T, sub: s2('answered'), door: 'local+factor' })
    expect(await destroyUnsatisfiedSessions(valkey, T, [s2('answered')]),
      'somebody who answered the old stance kept their session').toBe(1)
    expect(await countSweptSessions(valkey, T, [s2('answered')]), 'and it is gone').toBe(0)
  }, 60_000)

  it('a plain `local` session still goes — the on/off case is not regressed', async () => {
    await createSession(valkey, { tenantId: T, sub: s2('plain'), door: 'local' })
    expect(await destroyUnsatisfiedSessions(valkey, T, [s2('plain')])).toBe(1)
  }, 60_000)

  it.each([
    ['federated', 'an identity provider said who this is; ADR-219 §3 keeps it out of this policy'],
    ['operator', 'the break-glass path crosses requirements on purpose (#605) — it is the way back in'],
  ] as const)('a `%s` session stays, whatever the stance says', async (door, why) => {
    // The controls, and the invariant. Without them "sweep everything" satisfies both cases above —
    // which is exactly what the first version of this fix did: written as "not federated", it took the
    // operator session too, and #652's pin caught it. An allowlist is why that cannot recur silently.
    await createSession(valkey, { tenantId: T, sub: s2(door), door })
    expect(await destroyUnsatisfiedSessions(valkey, T, [s2(door)]), `${door}: ${why}`).toBe(0)
    expect(await countSweptSessions(valkey, T, [s2(door)]), `${door} was counted as swept`).toBe(0)
  }, 60_000)
})
