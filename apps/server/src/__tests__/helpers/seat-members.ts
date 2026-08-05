import type { Sql } from 'postgres'

// #624: a grant names somebody who is HERE. The routes refuse a principal with no `members` row now, so
// a fixture that grants to a synthetic sub has to seat it first.
//
// That is not a test detail dressed up as one. Before this guard, a grant to `user:anything-at-all`
// answered 204 and wrote a tuple nobody held — and the fixtures were the product's only user of that
// behaviour, which is why 125 of them relied on it. Seating the sub makes each fixture say what it
// actually means: "a member of this tenant, who then receives a grant".
//
// The subs are removed again in `afterAll`, so a file that seats one does not widen the shared dev
// tenant for whatever runs next (the debris lesson from #582's picker walks).
export async function seatMembers(sql: Sql, tenantId: string, subs: readonly string[]): Promise<void> {
  for (const sub of subs) {
    await sql`INSERT INTO members (tenant_id, sub, email, role)
              VALUES (${tenantId}, ${sub}, ${`${sub}@fixture.test`}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
}

export async function unseatMembers(sql: Sql, tenantId: string, subs: readonly string[]): Promise<void> {
  for (const sub of subs) {
    await sql`DELETE FROM members WHERE tenant_id = ${tenantId} AND sub = ${sub}`.catch(() => {})
  }
}
