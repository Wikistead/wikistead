// ADR-255 / #829: count the tuples whose object no longer exists — `pnpm fga:orphans`.
//
// THE PROBLEM this answers. Deletion and reset sweep the store from a MANIFEST: the object ids
// listed before the rows went. A manifest can only name what still has a row, so a tuple whose row
// was deleted first is invisible to every sweep the product has — and `routes/members.ts` produces
// exactly that on purpose, deleting a member's group tuples inside a catch that swallows failure and
// then removing the row. What is left is `user:<sub>` — a subject identifier — sitting on a group
// object with nothing anywhere that knows it is there. "Your data is gone" is a claim the four other
// stores can support by enumeration; OpenFGA cannot enumerate a tenant at all.
//
// ⚠️ THIS COMMAND ONLY COUNTS. Deleting is a separate command behind an explicit flag, ruled
// 2026-08-21 to need its own approval before it is written: the store is the one place where being
// wrong takes everything down at once (fail-closed — not a leak, a total stop).
//
// ⚠️ THE THREE THINGS THAT MAKE IT SAFE, each measured rather than assumed:
//
//   Orphanhood is a property of the OBJECT, never of the relation or the subject. `resync.ts:17-38`
//   names the columns where FGA is the ONLY truth — space grants, visibility markers, share links,
//   a draft's creator grant, two tenant defaults — and none of them has a database row. Judging by
//   relation would delete the product's own permission model.
//
//   The live set spans EVERY tenant, derived through the resolver. A promoted tenant's rows live in
//   `ns_<tenant>`, and `promote-tenant.ts` keeps the `public` copies for rollback — so a
//   `public`-only read finds a tenant promoted yesterday intact and loses everything a tenant has
//   done since ITS promotion. One tenant reading zero is the shape to fear, not all of them.
//
//   The store is read BEFORE the database. A page created during the scan then has its row in the
//   comparison; read the other way round, a live page becomes an orphan candidate. The grace window
//   is the second layer, not a replacement for the ordering.
import postgres from 'postgres'
import { OpenFgaClient } from '@openfga/sdk'
import { fgaClient, groupFgaId, runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'
import { acquireTenantDb } from '../db/tenant-db.js'
import { knownGroupNames } from '../auth/group-sync.js'
import { pool } from '../db/pool.js'

/** ADR-255 Decision 3: a tuple younger than this is reported as in-grace, never as an orphan. */
export const GRACE_MS = 24 * 60 * 60 * 1000

/** The object types the database can speak for. A type absent from here is UNRECONCILED, not clean. */
export const RECONCILED_TYPES = ['page', 'space', 'template', 'tenant', 'group'] as const
export type ReconciledType = (typeof RECONCILED_TYPES)[number]

export type ScannedTuple = { user: string; relation: string; object: string; writtenAt?: Date }

export type OrphanReport = {
  tenantsDerived: number
  tenantsTotal: number
  tuplesRead: number
  liveObjects: Record<string, number>
  orphans: Record<string, number>
  inGrace: Record<string, number>
  unreconciledTypes: Record<string, number>
  /** Every orphan, so a caller can assert on identity rather than on a total that other runs move. */
  orphanTuples: ScannedTuple[]
}

/**
 * ⚠️ The narrow per-tuple exception, and it is a list of exactly two triples — not of types.
 * `tenant` carries seven relations; scoping the exception to the type would strip space creation and
 * API-key issuance from a whole workspace and remove every group-granted administrator.
 */
const PER_TUPLE_EXCEPTIONS = [
  { type: 'group', relations: ['member'] },
  { type: 'tenant', relations: ['member', 'admin'] },
] as const

/** ADR-255 Decision 2b: ONE untyped scan. A type-only object filter is refused by the API (measured). */
export async function scanStore(fga: OpenFgaClient): Promise<ScannedTuple[]> {
  const out: ScannedTuple[] = []
  let continuationToken: string | undefined
  do {
    const res = await fga.read({}, { ...(continuationToken ? { continuationToken } : {}), pageSize: 100 })
    for (const t of res.tuples ?? []) {
      const k = t.key
      if (!k?.user || !k.relation || !k.object) continue
      out.push({ user: k.user, relation: k.relation, object: k.object, writtenAt: t.timestamp ? new Date(t.timestamp) : undefined })
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return out
}

export type LiveSet = {
  objects: Map<string, Set<string>>
  /** (tenant, name) → hash, so a scanned `group:<hash>` can be judged in ITS tenant and no other. */
  groupHashToTenant: Map<string, string>
  /** The subs with a members row, per tenant — the per-tuple predicate, asked in one tenant only. */
  membersByTenant: Map<string, Set<string>>
  derived: number
  total: number
}

/**
 * Derive the live set from every tenant, through the resolver.
 *
 * ⚠️ The handle matters more than the query. `members`, `pages` and `spaces` are FORCE RLS, so the
 * runtime role with no `app.tenant_id` reads ZERO rows — and zero rows means every tuple in the
 * store is an orphan candidate. An implementation written against the administrative DSN cannot
 * produce that state at all (a superuser bypasses FORCE RLS), which is why it would pass a test
 * written to forbid it. The resolver is what sets `app.tenant_id` and, for a promoted tenant, points
 * `search_path` at its schema.
 */
export async function deriveLiveSet(sql: postgres.Sql): Promise<LiveSet> {
  const tenants = await sql<{ id: string; slug: string; isolation: string; plan: string }[]>`
    SELECT id, slug, isolation, plan FROM tenants`
  const objects = new Map<string, Set<string>>()
  for (const t of RECONCILED_TYPES) objects.set(t, new Set())
  const groupHashToTenant = new Map<string, string>()
  const membersByTenant = new Map<string, Set<string>>()
  // The tenant registry is the live set for `tenant:` objects. It has no RLS (001), so it is read
  // on the handle passed in rather than through the resolver.
  for (const row of tenants) objects.get('tenant')!.add(row.id)

  let derived = 0
  for (const row of tenants) {
    const tenant = { id: row.id, slug: row.slug, isolation: row.isolation, plan: row.plan } as unknown as Tenant
    // ⚠️ A failure here aborts the whole run rather than skipping the tenant. The store is single and
    // `page:<id>` carries no tenant, so there is no way to exclude one tenant's tuples from a
    // store-wide scan — unlike ADR-252, which sweeps per workspace and can refuse one.
    const db = await acquireTenantDb(tenant)
    try {
      for (const [type, table] of [['page', 'pages'], ['space', 'spaces'], ['template', 'templates']] as const) {
        const rows = await db.sql<{ id: string }[]>`SELECT id FROM ${db.sql(table)}`
        for (const r of rows) objects.get(type)!.add(r.id)
      }
      for (const name of await knownGroupNames(db)) {
        const hash = groupFgaId(row.id, name)
        const seen = groupHashToTenant.get(hash)
        // ⚠️ Abort rather than let a Map overwrite: the failure a silent overwrite produces is
        // "judged against the wrong tenant", which is exactly what the reverse table exists to stop.
        if (seen && seen !== row.id) throw new Error(`group hash collision: ${hash} in ${seen} and ${row.id}`)
        groupHashToTenant.set(hash, row.id)
        objects.get('group')!.add(hash)
      }
      const members = await db.sql<{ sub: string }[]>`SELECT sub FROM members`
      membersByTenant.set(row.id, new Set(members.map((m) => m.sub)))
      derived++
    } finally {
      await db.release()
    }
  }
  return { objects, groupHashToTenant, membersByTenant, derived, total: tenants.length }
}

/** Judge a scanned store against a live set. Pure, so the rules can be tested without a store. */
export function judge(tuples: ScannedTuple[], live: LiveSet, now = Date.now()): OrphanReport {
  const orphans: Record<string, number> = {}
  const inGrace: Record<string, number> = {}
  const unreconciledTypes: Record<string, number> = {}
  const liveObjects: Record<string, number> = {}
  const orphanTuples: ScannedTuple[] = []
  for (const t of RECONCILED_TYPES) liveObjects[t] = live.objects.get(t)?.size ?? 0

  for (const tuple of tuples) {
    const [type, id] = [tuple.object.split(':')[0] ?? '', tuple.object.slice(tuple.object.indexOf(':') + 1)]
    if (!(RECONCILED_TYPES as readonly string[]).includes(type)) {
      unreconciledTypes[type] = (unreconciledTypes[type] ?? 0) + 1
      continue
    }
    const objectLives = live.objects.get(type)!.has(id)
    let orphan = !objectLives
    if (objectLives) {
      // The per-tuple exception: the object lives, but this ONE tuple names a subject the tenant no
      // longer has a members row for.
      const exception = PER_TUPLE_EXCEPTIONS.find((e) => e.type === type && (e.relations as readonly string[]).includes(tuple.relation))
      if (exception && tuple.user.startsWith('user:')) {
        const sub = tuple.user.slice('user:'.length)
        // ⚠️ "That tenant" comes from the reverse table, never from "some tenant": a sub in two
        // tenants keeps a row in one, and asking about the wrong one either spares every residue or
        // deletes a live membership.
        const tenantId = type === 'group' ? live.groupHashToTenant.get(id) : id
        const roster = tenantId ? live.membersByTenant.get(tenantId) : undefined
        if (roster && !roster.has(sub)) orphan = true
      }
    }
    if (!orphan) continue
    if (tuple.writtenAt && now - tuple.writtenAt.getTime() < GRACE_MS) {
      inGrace[type] = (inGrace[type] ?? 0) + 1
      continue
    }
    orphans[type] = (orphans[type] ?? 0) + 1
    orphanTuples.push(tuple)
  }
  return { tenantsDerived: live.derived, tenantsTotal: live.total, tuplesRead: tuples.length, liveObjects, orphans, inGrace, unreconciledTypes, orphanTuples }
}

export async function countOrphanTuples(sql: postgres.Sql, fga: OpenFgaClient): Promise<OrphanReport> {
  const tuples = await scanStore(fga) // store FIRST (Decision 3)
  const live = await deriveLiveSet(sql)
  return judge(tuples, live)
}

const isMain = process.argv[1]?.endsWith('orphan-tuple-count.ts') || process.argv[1]?.endsWith('orphan-tuple-count.js')
if (isMain) {
  // A standalone command does not get the authz scope the drain worker sets up for itself.
  await runInAuthzScope(SYSTEM_SCOPE, async () => {
    const report = await countOrphanTuples(pool as unknown as postgres.Sql, fgaClient)
    const fmt = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'
    console.log(`fga:orphans — ${report.tuplesRead} tuple(s) read, ${report.tenantsDerived}/${report.tenantsTotal} tenant(s) derived`)
    console.log(`  live objects   ${fmt(report.liveObjects)}`)
    console.log(`  orphans        ${fmt(report.orphans)}`)
    console.log(`  in grace       ${fmt(report.inGrace)}`)
    console.log(`  unreconciled   ${fmt(report.unreconciledTypes)}`)
    // #719: an empty derivation is a broken read, not a clean store. Said by exit code as well as by
    // a line, because a console.log alone can be swallowed by a later caller.
    if (report.tenantsDerived !== report.tenantsTotal) {
      console.error(`fga:orphans FAILED — derived ${report.tenantsDerived} of ${report.tenantsTotal} tenants; the run covered less than the registry.`)
      process.exit(1)
    }
    if (report.tenantsTotal === 0) {
      console.error('fga:orphans FAILED — the registry answered zero tenants, which is a broken read rather than an empty deployment.')
      process.exit(1)
    }
  })
  await pool.end()
}
