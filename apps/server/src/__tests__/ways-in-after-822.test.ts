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
import { waysInAfter, assertClosingIsSafe } from '../auth/login-methods.js'
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
    ['routes/members.ts', 'demoting an administrator — the key-taking half'],
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
