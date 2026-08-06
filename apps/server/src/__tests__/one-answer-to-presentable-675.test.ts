// #675 / ADR-222 §2: "can this member present a factor" has ONE answer.
//
// Four places asked it separately — the floor, the outbound guard, the sweep, and (through
// `hasConfirmedFactor`) the factor receipt — and each wrote its own `confirmed_at IS NOT NULL`. That is
// the shape #605's two-sided guard already cost this repository once: one side learns a new rule and the
// other keeps answering the old one. #672 is about to add a rule (which KINDS a tenant accepts), so the
// question gets one implementation first, before anything depends on the answer.
//
// The rule that mattered most is the one a reader does not expect: a passkey is bound to the HOST it was
// created on, and the sign-in lookup filters by it (`passkeys.ts:211`). After a domain move — which
// #664 lets a tenant make on acknowledgement — every key is still a row and none of them can answer. A
// floor counting rows is satisfied by keys nobody can present.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { adminWithFactorCount, membersUnsatisfiedBy, wouldStrandTenant, presentableKinds } from '../auth/factor-policy.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { storePasskey } from '../auth/passkeys.js'
import { generateTotpSecret } from '../auth/totp.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HERE = 'dev.localhost'
const ELSEWHERE = 'moved.example' // where the tenant used to live, before a #664 domain move
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let db: TenantDb
const subs: string[] = []

/** An admin holding one confirmed passkey, made at `rpId`. */
async function adminWithPasskeyAt(name: string, rpId: string): Promise<string> {
  const sub = `p675-${name}-${STAMP}`
  subs.push(sub)
  await admin`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'admin')
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin'`
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: name })
  await storePasskey(db, {
    tenantId: T, factorId,
    passkey: { credentialId: `cred-${name}-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId },
  })
  await confirmFactor(db, factorId)
  return sub
}

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(T))
  // dev-user is an admin of this tenant and its factors are shared with other files; clear ours only.
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = 'dev-user'`.catch(() => {})
}, 180_000)

afterAll(async () => {
  for (const sub of subs) {
    await admin`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${sub}`.catch(() => {})
  }
  await db.release(); await admin.end(); await pool.end()
}, 180_000)

describe('#675: a key from the old host cannot be presented here', () => {
  it('does not count towards the floor, and its holder reads as holding nothing', async () => {
    const moved = await adminWithPasskeyAt('moved', ELSEWHERE)

    expect(await presentableKinds(db, moved, HERE), 'the key exists and cannot answer here').toEqual([])
    expect(await adminWithFactorCount(db, HERE), 'so the tenant has no admin who can present one').toBe(0)
    // #679 renamed this and widened its question to "unsatisfied BY THIS STANCE"; `any` is what it
    // always asked — anything presentable will do.
    expect(await membersUnsatisfiedBy(db, 'any', HERE), 'and the sweep counts them as unprotected')
      .toContain(moved)
  }, 180_000)

  it('…and the same row counts at the host it was made on', async () => {
    // The control, and the whole reason the predicate takes a host rather than dropping passkeys.
    // Without it, "the floor is empty" would pass on an implementation that ignored passkeys entirely.
    const moved = subs.find((s) => s.includes('moved'))!
    expect(await presentableKinds(db, moved, ELSEWHERE)).toEqual(['passkey'])
    expect(await adminWithFactorCount(db, ELSEWHERE)).toBe(1)
  }, 180_000)

  it('a TOTP answers at any host — the secret is the product\'s, not a host\'s', async () => {
    const sub = `p675-app-${STAMP}`
    subs.push(sub)
    await admin`
      INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'admin')
      ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin'`
    const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)

    expect(await presentableKinds(db, sub, HERE)).toEqual(['totp'])
    expect(await presentableKinds(db, sub, ELSEWHERE), 'a domain move does not touch it').toEqual(['totp'])
  }, 180_000)

  it('the outbound guard asks the same question', async () => {
    // A tenant whose only admin key belongs to the old host is already stranded; giving up a factor
    // that could never answer must not be refused on the grounds that it was protecting anybody.
    const sub = subs.find((s) => s.includes('moved'))!
    const [row] = await admin<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${sub} AND confirmed_at IS NOT NULL`
    expect(await wouldStrandTenant(db, { memberSub: sub, factorId: row!.id, host: HERE }),
      'it strands nobody here — it was already unusable').toBe(false)

    // …and at its own host the same row IS the last way in, so it is held. The TOTP admin this file
    // seated earlier answers at every host and would otherwise be the "somebody else" that makes this
    // false — measured, and it made the case pass for the wrong reason before the delete.
    const app = subs.find((s2) => s2.includes('-app-'))!
    await admin`DELETE FROM member_factors WHERE member_sub = ${app}`
    expect(await wouldStrandTenant(db, { memberSub: sub, factorId: row!.id, host: ELSEWHERE }),
      'at its own host it is the last one').toBe(true)
  }, 180_000)
})

describe('#675: nothing asks the question its own way', () => {
  it('the confirmed-factor condition is written in one file', () => {
    // A discovery walk, not a list of the four that were wrong: a fifth place added next month is
    // caught here rather than by the review that finds two guards disagreeing.
    //
    // Two files are allowed to name it for reasons that are not counting: `second-factors.ts` LISTS a
    // member's factors (a display question, no policy in it), and `passkeys.ts` answers "which keys
    // would a domain move strand" (#664), which is about the move rather than about whether anybody
    // may sign in.
    const ALLOWED = new Set(['auth/factor-policy.ts', 'auth/second-factors.ts', 'auth/passkeys.ts'])
    // `routes/auth-local.ts` used to be here too: its sign-in query spelled the rule itself. It now
    // embeds the fragment, which is why this walk found it and why the list did not simply grow.
    const root = resolve(import.meta.dirname, '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = resolve(dir, e.name)
        if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(full)
        return e.name.endsWith('.ts') ? [full] : []
      })

    const offenders = walk(root)
      .filter((f) => /confirmed_at\s+IS\s+NOT\s+NULL/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1))
      .filter((rel) => !ALLOWED.has(rel))
    expect(offenders, `these ask "is it confirmed" without the host rule :: ${offenders.join(', ')}`).toEqual([])
  })

  it('…and the walk can actually see the file that does', () => {
    // Without this the case above passes on a broken walk (a renamed directory, a changed extension),
    // which is the vacuous shape this repository keeps paying for.
    const root = resolve(import.meta.dirname, '..')
    expect(/presentableHere/.test(readFileSync(resolve(root, 'auth/factor-policy.ts'), 'utf8')),
      'the one implementation is where the walk looked').toBe(true)
  })
})
