// Integration — real Postgres. ADR-251 / #822: `anAdminHoldsAKey` asked of a real database.
//
// ⚠️ WHY THIS FILE EXISTS. The rules of this predicate are pinned on a table-name stub
// (`ways-in-after-822.test.ts`), which answers any query that mentions `local_credentials` — so it
// answers a query naming a column that does not exist. It did: the shipped join read `c.sub`, the
// column is `member_sub` (migration 105), and every stub case stayed green because no stub case
// reaches a live table. The failure surfaced only where a real tenant had a password door open, as a
// 500 out of an admin write. A rule can be right and its query still be unaskable; both need pinning.
//
// Own tenant (tenant_t822k): the counts must be exact, which the shared dev tenant cannot promise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { anAdminHoldsAKey } from '../auth/login-methods.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_t822k'
const A = 't822k-admin'      // administrator, holds a password, exempt
const A2 = 't822k-admin2'    // administrator, holds a password, NOT exempt
const M = 't822k-member'     // ordinary member, holds a password
const D = 't822k-dead'       // administrator, holds a password, deactivated
const HASH = 'scrypt$notused'

let db: TenantDb

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${T}, 't822k', 'free') ON CONFLICT (slug) DO NOTHING`
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T}`
  await admin`DELETE FROM local_credentials WHERE tenant_id = ${T}`
  await admin`DELETE FROM members WHERE tenant_id = ${T}`
  for (const [sub, role, dead] of [[A, 'admin', false], [A2, 'admin', false], [M, 'member', false], [D, 'admin', true]] as const) {
    await admin`INSERT INTO members (tenant_id, sub, email, role, deactivated_at)
                VALUES (${T}, ${sub}, ${sub + '@t822k.test'}, ${role}, ${dead ? admin`now()` : null})`
  }
  for (const sub of [A, A2, M, D]) {
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                VALUES (${T}, ${sub}, ${sub + '@t822k.test'}, ${HASH})`
  }
  await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${T}, ${A}, 'test')`
  db = await acquireTenantDb({ id: T, slug: 't822k', plan: 'free', isolation: 'logical' } as Tenant)
})

afterAll(async () => {
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T}`
  await admin`DELETE FROM local_credentials WHERE tenant_id = ${T}`
  await admin`DELETE FROM members WHERE tenant_id = ${T}`
  await db?.release?.()
  await admin.end()
  await pool.end()
})

describe('#822 the key question, asked of a real database', () => {
  it('answers at all — the join names columns this schema has', async () => {
    // The regression case, stated plainly: `c.sub` threw here and no stub could see it.
    await expect(anAdminHoldsAKey(db)).resolves.toBe(true)
  })

  it('an ordinary member holding a password is not an administrator holding one', async () => {
    // Demote both live administrators. M (an ordinary member) and D (a deactivated administrator)
    // still hold passwords, so somebody can sign in — and nobody who can administer holds a key.
    await admin`UPDATE members SET role = 'member' WHERE tenant_id = ${T} AND sub IN (${A}, ${A2})`
    try {
      await expect(anAdminHoldsAKey(db), 'a member with a password counted as an administrator').resolves.toBe(false)
    } finally {
      await admin`UPDATE members SET role = 'admin' WHERE tenant_id = ${T} AND sub IN (${A}, ${A2})`
    }
  })

  it('a deactivated administrator does not hold a key', async () => {
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${T} AND member_sub IN (${A}, ${A2})`
    try {
      // Only D is left with a credential, and D is deactivated.
      await expect(anAdminHoldsAKey(db), 'a suspended administrator counted').resolves.toBe(false)
    } finally {
      for (const sub of [A, A2]) {
        await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                    VALUES (${T}, ${sub}, ${sub + '@t822k.test'}, ${HASH})`
      }
    }
  })

  it('`without` asks the counterfactual the key-taking writes need', async () => {
    await expect(anAdminHoldsAKey(db, { without: A })).resolves.toBe(true)   // A2 is still there
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${T} AND member_sub = ${A2}`
    try {
      await expect(anAdminHoldsAKey(db, { without: A }), 'removing the last key-holder still answered yes').resolves.toBe(false)
      await expect(anAdminHoldsAKey(db), 'the unexcluded question changed with it').resolves.toBe(true)
    } finally {
      await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                  VALUES (${T}, ${A2}, ${A2 + '@t822k.test'}, ${HASH})`
    }
  })

  it('`exemptOnly` narrows to the exemption list — spliced fragment and all', async () => {
    // ⚠️ The stub pin states it cannot see this: postgres.js splices the conditional join at SEND
    // time, so the template a stub inspects does not contain it. Here the database answers, so the
    // narrowing is measured rather than read. A and A2 both hold keys; only A is exempt.
    await expect(anAdminHoldsAKey(db, { exemptOnly: true })).resolves.toBe(true)
    await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T} AND member_sub = ${A}`
    try {
      await expect(anAdminHoldsAKey(db, { exemptOnly: true }), 'the join to an empty exemption list still answered yes').resolves.toBe(false)
      await expect(anAdminHoldsAKey(db), 'the unnarrowed question was narrowed too').resolves.toBe(true)
    } finally {
      await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${T}, ${A}, 'test')`
    }
  })
})
