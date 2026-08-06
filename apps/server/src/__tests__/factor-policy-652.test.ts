// #652 slice 1 / ADR-219 §2 §3 §4: what the second-factor policy admits.
//
// Every door is named on both sides of the switch, because the failure this pins is not a crash — it is
// a ruling quietly inverted. "Federated sign-ins are out of scope" and "a session with no recorded door
// is unsatisfied" are both in the ADR, and an implementation that reads them in order sends every OIDC
// member to an interstitial while following each sentence exactly.
import { describe, it, expect } from 'vitest'
import { factorVerdict, sessionVerdict, PRINCIPALS_OUTSIDE_POLICY } from '../auth/factor-policy.js'
import type { SessionDoor } from '../auth/session.js'

const DOORS: SessionDoor[] = ['local', 'local+factor', 'federated', 'operator']

describe('#652: with the policy off, nothing is asked of anybody', () => {
  it('admits every door', () => {
    for (const door of DOORS) {
      expect(factorVerdict({ policyOn: false, door }), `${door} with the policy off`).toBe('admit')
    }
  })
})

describe('#652: with the policy on', () => {
  it('asks the local door, and only the local door', () => {
    // Stated as the whole partition rather than one case at a time: a table that names the admits and
    // forgets to name the refusal (or the reverse) can be satisfied by a function that always says one
    // thing.
    const asked = DOORS.filter((door) => factorVerdict({ policyOn: true, door }) === 'require-factor')
    expect(asked, 'exactly one door is the policy\'s business').toEqual(['local'])
  })

  it('admits a local door that answered', () => {
    expect(factorVerdict({ policyOn: true, door: 'local+factor' })).toBe('admit')
  })

  it('admits a FEDERATED sign-in — the ruling this file exists to protect', () => {
    // ADR-219 §3. The product cannot verify what the IdP asked (`acr_values` is not sent, `amr` is
    // discarded), so asking anyway would be a second factor demanded in ignorance of the first.
    expect(factorVerdict({ policyOn: true, door: 'federated' })).toBe('admit')
  })

  it('admits the operator break-glass, which crosses requirements on purpose', () => {
    // ADR-219 §4. It already crosses the SSO stance; a self-hoster who has lost every authenticator
    // would otherwise lose the tenant.
    expect(factorVerdict({ policyOn: true, door: 'operator' })).toBe('admit')
  })
})

describe('#652: a session that predates the door field', () => {
  it('is asked, never grandfathered', () => {
    // Holding a cookie from last week must not be the way around a rule introduced this week.
    expect(sessionVerdict({}, true), 'no door recorded').toBe('require-factor')
    expect(sessionVerdict({ door: undefined }, true), 'explicitly absent').toBe('require-factor')
  })

  it('…and is admitted while the policy is off, like everything else', () => {
    expect(sessionVerdict({}, false)).toBe('admit')
  })

  it('reads a recorded door when there is one', () => {
    expect(sessionVerdict({ door: 'federated' }, true)).toBe('admit')
    expect(sessionVerdict({ door: 'local' }, true)).toBe('require-factor')
  })
})

describe('#652: the principals the policy does not cover', () => {
  it('names them, so the wiring slice asserts against a list rather than restating it', () => {
    // ADR-219 §5: four of the five ways a member principal is created never touch a session, so a
    // check written as "look at the session" simply does not run for them. That IS an exemption, and
    // it is better named here than discovered later as an accident.
    expect([...PRINCIPALS_OUTSIDE_POLICY].sort())
      .toEqual(['api-key', 'dev-token', 'guest', 'mcp-oauth', 'oidc-bearer'])
  })
})
