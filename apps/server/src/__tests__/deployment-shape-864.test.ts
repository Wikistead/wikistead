// #864: the screens can tell a self-hosted install from the managed one — and the answer is not a lever.
//
// The empty state offers a setup guide to the operator who just stood the server up, and must not
// offer it to a tenant on somebody else's server. Every entitlement is UNLIMITED in BOTH cases (a
// self-host by Community First, a top Cloud plan by paying for it), so the flags cannot answer this;
// the registration the edition performs once at composition time can (ADR-015: Cloud registers a
// resolver, self-host registers nothing).
//
// ⚠️ This is a pin on the WIRE. The client's condition is `selfHosted === true`, so a route that
// stopped sending the field would quietly turn the guide off for every self-hoster — no error, no
// red, just a screen that went back to telling an administrator to ask themselves.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isManagedDeployment, registerEntitlementsResolver, resetEntitlementsResolver, resolveEntitlements, UNLIMITED,
} from '@wikistead/entitlements'

afterEach(() => resetEntitlementsResolver())

/** What GET /entitlements answers, in the one line the route builds it from (billing.ts). */
const payload = (plan: string) => ({ ...resolveEntitlements(plan), selfHosted: !isManagedDeployment() })

describe('#864: the deployment shape is a fact about the composition, not about the plan', () => {
  it('and the route really answers with it — this file is not testing its own copy', () => {
    // `payload` above restates the route's one line. Restating is fine for driving the two
    // registrations, and useless if the route stops doing it: the copy would keep passing while the
    // wire went silent. So the source is read here, anchored on the two symbols rather than on the
    // spelling of the object literal.
    const route = readFileSync(resolve(import.meta.dirname, '../routes/billing.ts'), 'utf8')
    const handler = route.slice(route.indexOf("app.get('/entitlements'"), route.indexOf("app.get('/billing/usage'"))
    expect(handler, 'GET /entitlements no longer resolves the levers').toContain('resolveEntitlements(')
    expect(handler, 'GET /entitlements no longer reports the deployment shape').toContain('isManagedDeployment()')
  })

  it('a self-host registers nothing, and says so', () => {
    expect(isManagedDeployment()).toBe(false)
    expect(payload('anything').selfHosted).toBe(true)
  })

  it('a managed deployment registers a resolver, and says so', () => {
    registerEntitlementsResolver(() => UNLIMITED)
    expect(isManagedDeployment()).toBe(true)
    expect(payload('team').selfHosted).toBe(false)
  })

  it('no lever can stand in for it — both answer UNLIMITED', () => {
    // The reason this fact needed a home of its own. A screen that reached for `branding` (or any
    // other flag) to mean "self-hosted" would be right until the first tenant bought the top plan.
    const selfHost = payload('whatever')
    registerEntitlementsResolver(() => UNLIMITED) // a Cloud tenant on a plan that includes everything
    const topPlan = payload('team')
    const levers = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'selfHosted'))
    expect(levers(topPlan), 'the levers are identical in both deployments').toEqual(levers(selfHost))
    expect(topPlan.selfHosted, 'and only this field tells them apart').not.toBe(selfHost.selfHosted)
  })

  it('the route still carries every lever it carried before', () => {
    // The field rides along with the entitlements rather than replacing them; a client reading
    // `branding` must not lose it because a deployment fact moved in next door.
    const keys = Object.keys(payload('free'))
    for (const lever of Object.keys(UNLIMITED)) expect(keys, `the response dropped ${lever}`).toContain(lever)
    expect(keys.length, 'exactly one field beyond the levers').toBe(Object.keys(UNLIMITED).length + 1)
  })
})
