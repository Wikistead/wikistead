// ADR-251 / #822: the doors somebody can actually walk through, not the doors that are selected.
//
// THE DEFECT this replaces. Two guards were asking two different questions, and both were wrong in
// the same place. `otherLoginMethodsEffective` counts CONFIGURED methods and has no `local` branch at
// all, so a workspace on SAML plus passwords cannot turn SAML off — it is told to enable another
// method first, and another method is already enabled. `assertNotLastWayIn` does count the password
// door, but only as a PREFERENCE: a tenant where everybody signs in through the IdP and nobody holds
// a password satisfies it, so closing the last federated door there leaves a workspace with a door
// nobody has a key to. ⚠️ Ruled 2026-08-21: selected is not a way in.
//
// Pure unit, on a db stub keyed by table name — the same shape `login-methods-537.test.ts` uses. The
// rules are what is dangerous here; getting them wrong locks a workspace out, and the store is
// fail-closed, so the failure is not a leak but everybody losing access at once.
import { describe, it, expect, afterEach } from 'vitest'
import { waysInAfter, assertClosingIsSafe, assertNotLastExemptAdmin, anAdminHoldsAKey } from '../auth/login-methods.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TenantDb } from '../db/index.js'

type Stub = {
  oidcRows?: { id: string; enabled: boolean }[]
  samlEnabled?: boolean
  localSelected?: boolean
  adminWithKey?: number
  ssoRequired?: boolean
}

const dbStub = (o: Stub) =>
  ({
    sql: Object.assign(
      async (strings: TemplateStringsArray) => {
        const q = strings.join('?')
        if (q.includes('local_credentials')) return [{ n: o.adminWithKey ?? 0 }]
        if (q.includes('tenant_oidc')) return o.oidcRows ?? []
        if (q.includes('tenant_saml')) return o.samlEnabled === undefined ? [] : [{ enabled: o.samlEnabled }]
        if (q.includes('tenant_login_prefs')) return [{ local_login_enabled: !!o.localSelected, platform_login_disabled: false, sso_required: !!o.ssoRequired }]
        return []
      },
      { unsafe: async () => [] },
    ),
  }) as unknown as TenantDb

const TENANT = { id: 't1', plan: 'business' }
const NO_PLATFORM = 'local,tenant-oidc,saml' // the ceiling string: no platform IdP in this deployment

afterEach(() => { delete process.env.PLATFORM_OIDC_ISSUER })

describe('#822 a door that is selected is not a way in', () => {
  it('drops a password door no administrator holds a key to', async () => {
    // THE CASE THE RULING IS ABOUT. `local` is on, so the old guard counted it and allowed the write;
    // nobody can actually sign in with it.
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: true, adminWithKey: 0 })
    const after = await waysInAfter(db, TENANT, { id: 'c1', live: true }, NO_PLATFORM)
    expect(after, 'a key-less password door counted as a way in').toEqual([])
  })

  it('keeps it when an active administrator does hold one', async () => {
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: true, adminWithKey: 1 })
    const after = await waysInAfter(db, TENANT, { id: 'c1', live: true }, NO_PLATFORM)
    expect(after.map((w) => [w.kind, w.usable])).toEqual([['local', 'yes']])
  })

  it('⚠️ asks whether an ADMINISTRATOR holds the key, not whether anybody does', async () => {
    // Measured while break-checking: dropping `role = 'admin'` from the join left every case above
    // green, so the ruling's actual subject was untested. A workspace where ordinary members hold
    // passwords and no administrator does is the state the ruling forbids — somebody can sign in,
    // and nobody can administer.
    const q: string[] = []
    const db = {
      sql: Object.assign(
        async (strings: TemplateStringsArray) => {
          const text = strings.join('?')
          if (text.includes('local_credentials')) { q.push(text); return [{ n: 1 }] }
          if (text.includes('tenant_oidc')) return [{ id: 'c1', enabled: true }]
          if (text.includes('tenant_login_prefs')) return [{ local_login_enabled: true, platform_login_disabled: false, sso_required: false }]
          return []
        },
        { unsafe: async () => [] },
      ),
    } as unknown as TenantDb
    await waysInAfter(db, TENANT, { id: 'c1', live: true }, NO_PLATFORM)
    expect(q.length, 'the key question was never asked').toBeGreaterThan(0)
    expect(q[0], 'the key question does not restrict to administrators').toMatch(/role\s*=\s*'admin'/)
    expect(q[0], 'a deactivated administrator would count as a key holder').toMatch(/deactivated_at IS NULL/)
  })

  it('counts a federated door it cannot verify, rather than refusing every SSO-only tenant', async () => {
    // The other direction. The product cannot enumerate who an external IdP admits; claiming to have
    // verified one would be a lie, and refusing them would strand every SSO-only workspace.
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }, { id: 'c2', enabled: true }], localSelected: false })
    const after = await waysInAfter(db, TENANT, { id: 'c1', live: true }, NO_PLATFORM)
    expect(after.map((w) => w.usable)).toEqual(['unknown'])
  })

  it('steps aside when the door being closed is already shut', async () => {
    // `live: false` means the write takes nothing away — the same step-aside the older guard makes.
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: false })
    const after = await waysInAfter(db, TENANT, { id: 'gone', live: false }, NO_PLATFORM)
    expect(after.length, 'a write that closes nothing was judged as if it closed something').toBe(1)
  })
})

describe('#866 a write that takes the KEY away can close the last way in', () => {
  // THE DEFECT. The floor (`isLastAdmin`) counts administrators and never joins the credential
  // table, so with passwords the only door and two administrators — A holding one, B holding none —
  // demoting A passes the floor (B is still an administrator) and lands on the forbidden state:
  // members can sign in, nobody can administer, and the recovery is a command on the server.
  const oneAdminHoldsAKey = (holders: number) =>
    ({
      sql: Object.assign(
        async (strings: TemplateStringsArray, ...vals: unknown[]) => {
          const q = strings.join('?')
          // `holders` counts key-holding admins OTHER than the excluded one, which is what the
          // counterfactual asks: the stub answers 0 when the person being demoted is the only one.
          if (q.includes('local_credentials')) return [{ n: vals.some((v) => v === 'A') ? holders : holders + 1 }]
          if (q.includes('tenant_oidc')) return []
          if (q.includes('tenant_login_prefs')) return [{ local_login_enabled: true, platform_login_disabled: false, sso_required: false }]
          return []
        },
        { unsafe: async () => [] },
      ),
    }) as unknown as TenantDb

  it('refuses a demotion that leaves no administrator holding a key', async () => {
    await expect(assertClosingIsSafe(oneAdminHoldsAKey(0), TENANT, { demoting: 'A' }, { env: NO_PLATFORM }))
      .rejects.toMatchObject({ statusCode: 409, code: 'login_lockout' })
  })

  it('allows it when another administrator still holds one', async () => {
    await expect(assertClosingIsSafe(oneAdminHoldsAKey(1), TENANT, { demoting: 'A' }, { env: NO_PLATFORM }))
      .resolves.toBeUndefined()
  })

  it('asks the counterfactual about THAT person, not about the roster in general', async () => {
    // Without the exclusion the predicate answers "somebody holds a key" — which is true of the very
    // person being demoted, so the guard would wave through the write it exists to stop.
    const seen: unknown[][] = []
    const db = {
      sql: Object.assign(
        async (strings: TemplateStringsArray, ...vals: unknown[]) => {
          const q = strings.join('?')
          if (q.includes('local_credentials')) { seen.push(vals); return [{ n: 1 }] }
          if (q.includes('tenant_login_prefs')) return [{ local_login_enabled: true, platform_login_disabled: false, sso_required: false }]
          return []
        },
        { unsafe: async () => [] },
      ),
    } as unknown as TenantDb
    await waysInAfter(db, TENANT, { demoting: 'A' }, NO_PLATFORM)
    expect(seen.length, 'the key question was never asked').toBeGreaterThan(0)
    expect(seen[0], 'the excluded member was not passed to the key question').toContain('A')
  })
})

describe('#822 / #866 every door-closing write asks the question', () => {
  // ⚠️ Measured while break-checking: removing the guard from the demotion route left every case
  // above green, because a pure unit over the predicate cannot see whether anybody calls it. The
  // rules and the wiring are two different things to get wrong, and this ticket is about a guard that
  // existed and asked the wrong question — a guard that does not exist at all is the same defect with
  // the volume turned up.
  const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8')

  const CLOSING_WRITES: ReadonlyArray<readonly [string, string]> = [
    ['routes/admin-connections.ts', 'disabling a connection, and deleting one'],
    ['routes/tenant-oidc.ts', 'disabling the tenant IdP'],
    ['routes/members.ts', 'demoting an administrator, and removing one — the key-taking half'],
    // #925 / ADR-251 §3.8d: `suspendMember` writes `members.role` NOWHERE (it only clears it via
    // deactivation columns), so it lived outside every file this ledger already named — exactly the
    // shape #925 itself is a report of (§3.7 named four writes; this ledger did not independently
    // notice three of them were unguarded). One line, so the ledger stays one file short of nothing.
    ['auth/member-suspension.ts', 'suspending a member — SCIM inherits the same verb for free'],
  ]

  it.each(CLOSING_WRITES.map(([f, why]) => [f, why] as const))('%s asks it (%s)', (file) => {
    expect(read(file), `${file} closes a door without asking`).toContain('assertClosingIsSafe(')
  })

  it('the retired predicate is gone, not left beside the new one', () => {
    // A "does not count the password door" function left in the module is how the next feature picks
    // it up — which is exactly how the SAML guard came to have it.
    expect(read('auth/login-methods.ts')).not.toMatch(/export async function otherLoginMethodsEffective/)
  })

  it('each route carries a receptacle for repeating itself', () => {
    // A route without one is a button the console loses the day the answer becomes confirm_required.
    for (const [file] of CLOSING_WRITES) {
      expect(read(file), `${file} cannot accept a confirmation`).toMatch(/confirm/)
    }
  })
})

describe('#836 requiring SSO needs an exempt ADMINISTRATOR, not any exempt member', () => {
  // THE DEFECT. The precondition asked whether ANY exempt member holds a password and never looked at
  // `members.role`. An exemption list of ordinary members satisfied it, so the IdP going down left a
  // workspace people could sign in to and nobody could administer — the forbidden state again,
  // reached from the other side of the same door.
  const asked: string[] = []
  const db = {
    sql: Object.assign(
      async (strings: TemplateStringsArray) => {
        const q = strings.join('?')
        if (q.includes('local_credentials')) { asked.push(q); return [{ n: 1 }] }
        return []
      },
      { unsafe: async () => [] },
    ),
  } as unknown as TenantDb

  it('narrows the shared predicate to the exemption list, rather than writing a second rule', () => {
    // The point is not that a query exists; it is that the PRECONDITION (is this an admin with a key?)
    // answers both the ON and OFF questions through the one predicate. Two copies of THAT ANSWER is how
    // this family arrived at two guards that disagreed. #935 later joined `members` in the LIST route
    // above this one for an unrelated reason (displaying role — a fact, not a precondition decision),
    // so the scan is narrowed to the precondition's own route (DELETE, the last one in the file) rather
    // than the whole file — matching the slicing the other two cases in this block already use.
    const src = readFileSync(resolve(import.meta.dirname, '../routes/admin-login-methods.ts'), 'utf8')
    const precondition = src.slice(src.indexOf("app.delete<{ Params: { sub: string } }>('/admin/sso-exemptions/:sub'"))
    expect(precondition, 'the precondition writes its own rule instead of asking the shared one').toContain('anAdminHoldsAKey(req.db, { exemptOnly: true')
    expect(precondition, 'a second copy of the role predicate is back').not.toMatch(/JOIN members m ON m\.sub = se\.member_sub/)
  })

  it('narrows the same predicate rather than writing a second one', () => {
    // ⚠️ Measured honestly, and the limit is stated. postgres.js splices a fragment at SEND time, so
    // the conditional join is not in the template a stub sees — a first version of this case matched
    // the query string and failed while the join was working. That the splice REALLY changes the
    // answer was measured separately against a live database (a join to nothing: 0 rows against 729).
    // What is asserted here is that one predicate carries both questions, which is the property this
    // ticket is about: the two older guards disagreed because the rule was written twice.
    const src = readFileSync(resolve(import.meta.dirname, '../auth/login-methods.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function anAdminHoldsAKey'))
    expect(body, 'the exemption narrowing is not part of this predicate').toMatch(/exemptOnly[\s\S]{0,200}sso_exemptions/)
    expect(body, 'the role restriction moved out of the shared predicate').toMatch(/role\s*=\s*'admin'/)
    expect(body, 'a deactivated administrator would count').toMatch(/deactivated_at IS NULL/)
  })

  it('the general per-connection question is not built with the exemption narrowing baked in', () => {
    // Only the SSO precondition narrows to the exempt list; the doors ask about administrators
    // generally. A narrowing that leaked into the GENERAL question would refuse writes for the wrong
    // reason. ⚠️ #925 / ADR-251 §3.8b: `waysInAfter`'s key-taking branch now ALSO calls
    // `anAdminHoldsAKey` with `exemptOnly` — legitimately, for the synthetic exempt door — so a bare
    // substring scan of the whole function (the shape this pin used before #925) would false-positive
    // on that addition. What must still never happen is the per-connection LOOP's own general
    // question — asked once per remaining connection, in either branch — narrowing itself.
    const src = readFileSync(resolve(import.meta.dirname, '../auth/login-methods.ts'), 'utf8')
    const waysIn = src.slice(src.indexOf('export async function waysInAfter'), src.indexOf('export async function anAdminHoldsAKey'))
    const generalCalls = [...waysIn.matchAll(/if \(await anAdminHoldsAKey\(db(?:, \{[^}]*\})?\)\)/g)].map((m) => m[0])
    expect(generalCalls.length, 'the general per-connection question moved or was renamed — re-read this file before trusting it').toBe(2)
    for (const call of generalCalls) {
      expect(call, 'the door question narrowed itself to the exemption list').not.toMatch(/exemptOnly/)
    }
  })
})

describe('#822 the three answers', () => {
  it('allows a write that leaves a door somebody has a key to', async () => {
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: true, adminWithKey: 1 })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { env: NO_PLATFORM })).resolves.toBeUndefined()
  })

  it('refuses a write that leaves nothing at all', async () => {
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: true, adminWithKey: 0 })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { env: NO_PLATFORM }))
      .rejects.toMatchObject({ statusCode: 409, code: 'login_lockout' })
  })

  it('asks for confirmation when one unverifiable door is left, and names it', async () => {
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }, { id: 'c2', enabled: true }], localSelected: false })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { env: NO_PLATFORM }))
      .rejects.toMatchObject({ statusCode: 409, code: 'confirm_required', remainingKind: 'oidc' })
  })

  it('lets the same write through when it repeats itself with confirm', async () => {
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }, { id: 'c2', enabled: true }], localSelected: false })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { confirm: true, env: NO_PLATFORM })).resolves.toBeUndefined()
  })

  it('⚠️ does not ask when two or more doors remain — the tidy-up case', async () => {
    // rev1 asked whenever nothing remaining was PROVABLY usable, and since `yes` can only come from
    // `local`, that turned every ordinary connection tidy-up in an SSO-only tenant into a 409. The
    // ruling says "the last living way in", so the trigger is literally that.
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }, { id: 'c2', enabled: true }, { id: 'c3', enabled: true }], localSelected: false })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { env: NO_PLATFORM })).resolves.toBeUndefined()
  })

  it('confirm cannot buy its way past a lockout', async () => {
    // The flag is inert unless the answer is confirm_required — a client that always sends it must
    // not be able to skip the refusal.
    const db = dbStub({ oidcRows: [{ id: 'c1', enabled: true }], localSelected: true, adminWithKey: 0 })
    await expect(assertClosingIsSafe(db, TENANT, { id: 'c1', live: true }, { confirm: true, env: NO_PLATFORM }))
      .rejects.toMatchObject({ code: 'login_lockout' })
  })
})

describe('#925 / ADR-251 §3.8a: assertNotLastExemptAdmin — warned, not refused outright', () => {
  // A purpose-built stub. `exemptOnly`'s conditional JOIN fragment is invisible to a strings-only stub
  // (documented above, #822's own measured limit — postgres.js splices it at send time, and this fake
  // tag function's OWN recursive call for the fragment resolves to a value, never rejoining the outer
  // template's `strings`). Order is the only knob available: `assertNotLastExemptAdmin` asks
  // `anAdminHoldsAKey` at most twice, in a fixed sequence — `{exemptOnly, without: sub}` then, only if
  // that answered 0, `{exemptOnly}` alone — so `answers` is consumed in that order.
  const stub = (opts: { selected: boolean; exempt: boolean; answers: number[] }) => {
    let i = 0
    return {
      sql: Object.assign(
        async (strings: TemplateStringsArray) => {
          const q = strings.join('?')
          if (q.includes('sso_exemptions')) return opts.exempt ? [{ member_sub: 'A' }] : []
          if (q.includes('local_credentials')) { const n = opts.answers[i] ?? 0; i++; return [{ n }] }
          if (q.includes('tenant_login_prefs')) return [{ sso_required: opts.selected, local_login_enabled: false, platform_login_disabled: false }]
          return []
        },
        { unsafe: async () => [] },
      ),
    } as unknown as TenantDb
  }

  it('steps aside when the stance is not selected at all', async () => {
    const db = stub({ selected: false, exempt: true, answers: [0, 0] })
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', false)).resolves.toBeUndefined()
  })

  it("steps aside when the write's target is not exempt — not this floor's business", async () => {
    const db = stub({ selected: true, exempt: false, answers: [0, 0] })
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', false)).resolves.toBeUndefined()
  })

  it('steps aside when another exempt admin still holds a key', async () => {
    const db = stub({ selected: true, exempt: true, answers: [1] }) // first call (without A) answers 1
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', false)).resolves.toBeUndefined()
  })

  it('TRANSITION: steps aside when the floor was already down — refusing would take nothing back', async () => {
    // first call (without A) answers 0 — nobody else holds one; second call (A included) ALSO answers
    // 0 — so A never held a key either, meaning this write removes nothing the floor still had.
    const db = stub({ selected: true, exempt: true, answers: [0, 0] })
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', false)).resolves.toBeUndefined()
  })

  it('WARNS (confirm_required, not a hard refusal) when this write empties the floor', async () => {
    // first call (without A) answers 0; second call (A included) answers 1 — A itself is the floor.
    const db = stub({ selected: true, exempt: true, answers: [0, 1] })
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', false))
      .rejects.toMatchObject({ statusCode: 409, code: 'confirm_required' })
  })

  it('RULED 2026-08-27 (#925): a repeat with confirm goes through — the warning can be overridden', async () => {
    const db = stub({ selected: true, exempt: true, answers: [0, 1] })
    await expect(assertNotLastExemptAdmin(db, TENANT, 'A', true)).resolves.toBeUndefined()
  })
})

describe('#925 / ADR-251 §3.8b: an exempt admin with an open password door is a real way in', () => {
  // Reproduces the ADR's own measured table: sso_required, one federated connection, A is the sole
  // exempt admin holding a password. Wired the way the routes wire it — assertNotLastExemptAdmin
  // first, then assertClosingIsSafe — so this is also the regression test for §3.8's core bug (a
  // harmless admin's suspension/removal/demotion asking confirm_required for a floor it never touched).
  const scenario = (excludedIsTheExemptKeyHolder: boolean) => {
    // waysInAfter's key-taking branch asks, per remaining connection, `anAdminHoldsAKey(db, {without})`
    // (general — answers 0, `local` is stripped from `effective` under a biting stance so this branch
    // is never reached for a `local` entry) and then ONE call for the synthetic exempt door,
    // `anAdminHoldsAKey(db, {exemptOnly, without})`: 1 if A still holds the floor (excluded is NOT A),
    // 0 if excluded IS A (the write takes A's own key away).
    let i = 0
    const answers = excludedIsTheExemptKeyHolder ? [0] : [1]
    return {
      sql: Object.assign(
        async (strings: TemplateStringsArray) => {
          const q = strings.join('?')
          if (q.includes('sso_exemptions')) return excludedIsTheExemptKeyHolder ? [{ member_sub: 'A' }] : []
          if (q.includes('local_credentials')) { const n = answers[i] ?? 0; i++; return [{ n }] }
          if (q.includes('tenant_oidc')) return [{ id: 'c1', enabled: true }]
          if (q.includes('tenant_saml')) return []
          if (q.includes('tenant_login_prefs')) return [{ sso_required: true, local_login_enabled: true, platform_login_disabled: false }]
          return []
        },
        { unsafe: async () => [] },
      ),
    } as unknown as TenantDb
  }

  it("waysInAfter carries a synthetic 'yes' door when the exempt admin's password door is open", async () => {
    const db = scenario(false) // closing somebody who is NOT the exempt key-holder
    const after = await waysInAfter(db, TENANT, { deactivating: 'B' }, NO_PLATFORM)
    expect(after.map((w) => [w.kind, w.usable])).toContainEqual(['local', 'yes'])
  })

  it('demoting/suspending/deleting the harmless admin B is ALLOWED — B never held the exempt floor up', async () => {
    // THE regression this ticket exists to fix: before §3.8b, `local` is stripped from `effective`
    // under a biting stance, so no entry can ever be `'yes'`, and `assertClosingIsSafe` asked
    // `confirm_required` for every key-taking write regardless of whose key it was.
    const db = scenario(false)
    await expect(assertNotLastExemptAdmin(db, TENANT, 'B', false)).resolves.toBeUndefined()
    await expect(assertClosingIsSafe(db, TENANT, { deactivating: 'B' }, { env: NO_PLATFORM })).resolves.toBeUndefined()
  })

  // Closing A (the exempt key-holder) itself is §3.8a's own question — covered by the "WARNS" and
  // "TRANSITION" cases in the describe block above, which exercise `assertNotLastExemptAdmin` in
  // isolation with a call sequence matched to ITS two-call shape (this block's `scenario` stub is
  // shaped for `waysInAfter`'s different, single-call sequence instead — reusing it here silently
  // answers a different question than the one asked, the same trap #925's own C reproduction found).
})
