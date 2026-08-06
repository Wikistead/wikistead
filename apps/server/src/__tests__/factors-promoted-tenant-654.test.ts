// #654 review reject: the explicit delete on the member-removal path was unprotected.
//
// Removing a member already takes their factors in the shared schema — the composite FK cascades — so
// the line that says it out loud could be deleted and every test stayed green. That is worse than a
// break that shows up on promotion day: it is a break nobody would notice ON promotion day, because
// `provisionNamespaceSchema` mirrors columns, defaults, checks, keys and indexes and NOT foreign keys
// (`namespace.ts` says so in its own words). In a namespaced tenant that one statement is the only
// thing standing between a removed member and an authenticator that outlives them — and `sub`s are
// reused, so the row attaches to whoever holds it next.
//
// So this measures the promoted tenant, where the constraint does not exist.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { namespaceSchema, provisionNamespaceSchema, promoteTenantToNamespace } from '../db/namespace.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const T = `nsf654_${STAMP}`
const schema = namespaceSchema(T)
const VICTIM = `wlocal_nsf654-${STAMP}`
const ADMIN_SUB = 'dev-user'

let app: FastifyInstance

const tuples = [
  { user: `user:${ADMIN_SUB}`, relation: 'member', object: `tenant:${T}` },
  { user: `user:${ADMIN_SUB}`, relation: 'admin', object: `tenant:${T}` },
  { user: `user:${VICTIM}`, relation: 'member', object: `tenant:${T}` },
]

/** Rows live in the tenant's own schema once promoted, so the fixture reads name it explicitly. */
const factorsInSchema = async (): Promise<number> => {
  const rows = await admin.unsafe(
    `SELECT count(*)::int AS n FROM ${schema}.member_factors WHERE member_sub = $1`, [VICTIM],
  ) as unknown as { n: number }[]
  return rows[0]!.n
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${T}, ${T}, 'business', 'logical') ON CONFLICT (id) DO NOTHING`
  // seed while still logical, then promote — the lifecycle the driver supports (namespace.test.ts)
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${T}, true)`
    await tx`INSERT INTO members (tenant_id, sub, role) VALUES (${T}, ${ADMIN_SUB}, 'admin')`
    await tx`INSERT INTO members (tenant_id, sub, role) VALUES (${T}, ${VICTIM}, 'member')`
    await tx`INSERT INTO member_factors (tenant_id, member_sub, kind, label) VALUES (${T}, ${VICTIM}, 'totp', 'phone')`
  })
  await provisionNamespaceSchema(T, admin)
  await promoteTenantToNamespace({ id: T, slug: T, plan: 'business', isolation: 'logical' } as Tenant, admin)
  await admin`UPDATE tenants SET isolation = 'namespace' WHERE id = ${T}`
  await writeTuples(fgaClient, tuples).catch(() => {})
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, tuples).catch(() => {})
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${T}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#654: in a tenant with its own schema, the delete is the only thing that runs', () => {
  it('the mirrored table has the column shape and NOT the foreign key', async () => {
    // The premise, measured rather than quoted: if the FK were mirrored, the case below would pass
    // against an implementation with no explicit delete at all, and would prove nothing.
    const [t] = await admin<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'member_factors'`
    expect(Number(t!.n), 'the table is mirrored into the tenant schema').toBe(1)
    const [fk] = await admin<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.table_constraints
      WHERE table_schema = ${schema} AND table_name = 'member_factors' AND constraint_type = 'FOREIGN KEY'`
    expect(Number(fk!.n), 'and its foreign keys are NOT — this is why the statement matters').toBe(0)
  }, 60_000)

  it('removing the member removes their factors', async () => {
    expect(await factorsInSchema(), 'the promoted tenant carries the factor').toBe(1)

    const res = await app.inject({
      method: 'DELETE', url: `/members/${encodeURIComponent(VICTIM)}`,
      headers: { host: `${T}.localhost`, authorization: 'Bearer dev-token' },
    })
    expect(res.statusCode, `the removal answered :: ${res.body}`).toBeLessThan(400)
    // With no constraint behind it, this is the statement in `members.ts` and nothing else.
    expect(await factorsInSchema(), 'a factor outlived its member in a namespaced tenant').toBe(0)
  }, 180_000)
})
