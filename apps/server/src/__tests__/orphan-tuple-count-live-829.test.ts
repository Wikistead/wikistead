// Integration — real OpenFGA + real Postgres. ADR-255 / #829: the acceptance the counting slice's
// unit pins cannot reach.
//
// ⚠️ WHY THIS FILE EXISTS. `orphan-tuple-count-829.test.ts` measures `judge` as a pure function over
// a hand-built live set. That is the right place for the RULES, and it is blind to everything that
// makes them true in a deployment: whether the store scan returns anything, whether the derivation
// reads a promoted tenant's own schema, whether the handle it uses can see rows at all. The ticket
// was landed with that gap stated out loud rather than hidden; this closes it.
//
// ⚠️ The clock is the one thing simulated. Grace is 24 hours and a tuple's timestamp comes from the
// store, so ageing one is not something a test can wait for — `judge` takes `now`, and the scan and
// the derivation either side of it are real. Simulating the clock is not the same as simulating the
// store: everything the rules are asked ABOUT is measured.
//
// ⚠️ Own tenants, and every tuple written here is deleted in afterAll. This scans the WHOLE store, so
// residue left behind would surface as another session's mystery orphan.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples, groupFgaId, runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import { namespaceSchema, provisionNamespaceSchema, promoteTenantToNamespace } from '../db/namespace.js'
import { scanStore, deriveLiveSet, judge, GRACE_MS } from '../scripts/orphan-tuple-count.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const T1 = `orph829_${STAMP}`          // logical: the planted orphan and the grant-only group
const T2 = `orph829ns_${STAMP}`        // promoted: the page created AFTER promotion
const SUB = 'dev-user'
const GRANT_ONLY_GROUP = `orph829-grant-only-${STAMP}`

const deadPageId = randomUUID()        // a page row that will be deleted, tuple left behind
const space1 = randomUUID()            // pages carry a NOT NULL space_id with a composite FK
const space2 = randomUUID()
const roleId = randomUUID()
const assignmentId = randomUUID()
let nsPageId = ''                      // a page whose row exists ONLY in ns_<T2>
const grantGroupHash = () => groupFgaId(T1, GRANT_ONLY_GROUP)

const writtenTuples: { user: string; relation: string; object: string }[] = []
const write = async (t: { user: string; relation: string; object: string }) => {
  await writeTuples(fgaClient, [t])
  writtenTuples.push(t)
}

// Judged with the clock pushed a day past grace: what the run would say tomorrow.
const AGED = () => Date.now() + GRACE_MS + 60_000

let scanned: Awaited<ReturnType<typeof scanStore>> = []
let live: Awaited<ReturnType<typeof deriveLiveSet>>

beforeAll(async () => {
  for (const t of [T1, T2]) {
    await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${t}, ${t}, 'business', 'logical') ON CONFLICT (id) DO NOTHING`
  }
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${T1}, true)`
    await tx`INSERT INTO members (tenant_id, sub, role) VALUES (${T1}, ${SUB}, 'admin')`
    await tx`INSERT INTO spaces (tenant_id, id, name) VALUES (${T1}, ${space1}, 'orph829')`
    // A page row that exists now and will be deleted below, leaving its tuple with no object.
    await tx`INSERT INTO pages (tenant_id, id, space_id, title, created_by) VALUES (${T1}, ${deadPageId}, ${space1}, 'orph829 doomed', ${`user:${SUB}`})`
    // A group name NOBODY carries in members.groups — only a GRANT names it (the third branch of
    // `knownGroupNames`'s union). Narrowing the live set back to members.groups makes this group's
    // tuple an orphan, and deleting it would take a live grant's subject with it.
    await tx`INSERT INTO roles (id, tenant_id, name, capabilities) VALUES (${roleId}, ${T1}, ${'orph829-role'}, ${tx.array(['space.view'])})`
    await tx`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, group_name)
             VALUES (${assignmentId}, ${T1}, ${roleId}, 'space', ${space1}, ${`group:${GRANT_ONLY_GROUP}#member`}, ${GRANT_ONLY_GROUP})`
  })

  // ── the promoted tenant, and a page created AFTER promotion ────────────────────────────────────
  // ⚠️ Testing with a just-promoted tenant proves nothing: `promote-tenant` keeps the `public` copies
  // for rollback, so its rows are readable either way. Only a row created after the move lives in
  // `ns_<tenant>` alone, which is what a `public`-fixed derivation loses.
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${T2}, true)`
    await tx`INSERT INTO members (tenant_id, sub, role) VALUES (${T2}, ${SUB}, 'admin')`
    await tx`INSERT INTO spaces (tenant_id, id, name) VALUES (${T2}, ${space2}, 'orph829 ns')`
  })
  await provisionNamespaceSchema(T2, admin)
  await promoteTenantToNamespace({ id: T2, slug: T2, plan: 'business', isolation: 'logical' } as Tenant, admin)
  await admin`UPDATE tenants SET isolation = 'namespace' WHERE id = ${T2}`
  nsPageId = randomUUID()
  await admin.unsafe(
    `INSERT INTO ${namespaceSchema(T2)}.pages (tenant_id, id, space_id, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [T2, nsPageId, space2, 'orph829 after promotion', `user:${SUB}`],
  )

  // ⚠️ `manage_direct`, not `owner`: the relation has to be one the model ACCEPTS for `user` — a
  // relation that merely exists is not one that takes this subject type, and the store refuses the
  // write outright rather than storing something unusable.
  await write({ user: `user:${SUB}`, relation: 'manage_direct', object: `page:${deadPageId}` })
  await write({ user: `user:${SUB}`, relation: 'manage_direct', object: `page:${nsPageId}` })
  await write({ user: `user:${SUB}`, relation: 'member', object: `group:${grantGroupHash()}` })

  // The plant: the row goes, the tuple stays. This is `members.ts`'s shape, written on purpose.
  await admin`DELETE FROM pages WHERE tenant_id = ${T1} AND id = ${deadPageId}`

  await runInAuthzScope(SYSTEM_SCOPE, async () => {
    scanned = await scanStore(fgaClient)                                  // store FIRST (Decision 3)
    live = await deriveLiveSet(pool as unknown as postgres.Sql)
  })
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, writtenTuples).catch(() => {})
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespaceSchema(T2)} CASCADE`).catch(() => {})
  for (const t of [T1, T2]) {
    // ⚠️ roles rows are why an isolated stack goes stale (they count against the page cap other
    // suites assert on), so they go before the tenant does.
    await admin`DELETE FROM role_assignments WHERE tenant_id = ${t}`.catch(() => {})
    await admin`DELETE FROM roles WHERE tenant_id = ${t}`.catch(() => {})
    await admin`DELETE FROM pages WHERE tenant_id = ${t}`.catch(() => {})
    await admin`DELETE FROM spaces WHERE tenant_id = ${t}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${t}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${t}`.catch(() => {})
  }
  await admin.end()
  await pool.end()
}, 120_000)

const found = (object: string, report = judge(scanned, live, AGED())) =>
  report.orphanTuples.filter((t) => t.object === object)

describe('#829 the scan and the derivation, against the real pair', () => {
  it('reads the store at all — a scan that returns nothing would make every rule vacuous', () => {
    expect(scanned.length, 'the store scan came back empty; nothing below would mean anything').toBeGreaterThan(0)
    expect(scanned.some((t) => t.object === `page:${deadPageId}`), 'the planted tuple is not in the scan').toBe(true)
  })

  it('derives from every tenant, or the run must not proceed', () => {
    expect(live.total, 'the tenant registry read empty').toBeGreaterThan(0)
    expect(live.derived, 'a tenant failed to derive — the run aborts rather than call its objects gone').toBe(live.total)
  })

  it('plants an orphan and finds THAT one — never a total', () => {
    // ⚠️ Identity, not a count. Two writers put tenant triples in this store with no row behind them
    // (the FGA seed and the e2e fixtures' `stranger`), so "the report says N" is a number that moves
    // with whatever else has run.
    expect(found(`page:${deadPageId}`).length, 'the tuple whose page row was deleted was not reported').toBe(1)
  })

  it('holds the same tuple IN GRACE while it is young', () => {
    // The other half of the same plant: today it is in grace, tomorrow it is an orphan. A design
    // without the window calls a page created during the scan an orphan.
    const now = judge(scanned, live, Date.now())
    expect(now.orphanTuples.some((t) => t.object === `page:${deadPageId}`), 'a tuple minutes old was called an orphan').toBe(false)
    expect(now.inGrace['page'] ?? 0, 'the young tuple was not counted as in-grace either').toBeGreaterThan(0)
  })

  it('⚠️ a promoted tenant keeps its permissions: the derivation reads ITS schema', () => {
    // The failure to fear is ONE tenant reading zero, not all of them — and it only appears for rows
    // created after the move, because promotion keeps the `public` copies for rollback.
    expect(live.objects.get('page')!.has(nsPageId), 'a page created after promotion is missing from the live set').toBe(true)
    expect(found(`page:${nsPageId}`).length, 'a promoted tenant\'s live page was reported as an orphan').toBe(0)
  })

  it('⚠️ …and that case is not vacuous: a `public`-fixed read cannot see the row', async () => {
    // Without this, the assertion above passes on a deployment where the row happens to be in
    // `public` too, and the pin would defend nothing. Measured directly rather than assumed.
    const inPublic = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public.pages WHERE id = ${nsPageId}`
    expect(inPublic[0]!.n, 'the row is in public after all — this pin would pass with a public-fixed derivation').toBe(0)
  })

  it('a group only a GRANT names is not an orphan', () => {
    // `knownGroupNames` unions members.groups with group_role_mappings and role_assignments.
    // Narrowing it back to members.groups makes this tuple an orphan and takes a live grant with it.
    expect(live.objects.get('group')!.has(grantGroupHash()), 'the grant-only group is missing from the live set').toBe(true)
    expect(found(`group:${grantGroupHash()}`).length, 'a group named only by a grant was reported as an orphan').toBe(0)
  })
})
