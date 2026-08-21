// #788: remove the tenants earlier runs left behind in the isolated test database.
//
// Every fixture that needs isolation makes a tenant (`privateTenant`), and every run that is killed
// mid-file leaves it there. Nothing collects them, so the test database accumulates them forever: 979
// on a stack that had been up for four hours, against the two the seed creates.
//
// That is not merely untidy. `sweepExpiredTrash` walks EVERY tenant — `registry.findById`,
// `acquireTenantDb`, two queries, release — so its cost is linear in how many have piled up and has
// nothing to do with how much has actually expired. Measured on that stack: 33.2 seconds to purge one
// page tree, and about the same again to purge nothing, against a 60-second budget. The retention
// test did not get slower; the database it runs against got fuller.
//
// The FGA store accumulates the same way, but its tuples are keyed by ids that no longer exist and
// nothing walks them, so this stops at the database.
//
// ⚠️ DESTRUCTIVE, and deliberately narrow: it runs from `setup:server-test`, refuses to run anywhere
// but the isolated stack (#269's valve, the same one apps/server and the EE package carry), and keeps
// the two tenants the seed owns. Everything else in that database was made by a test.
import postgres from 'postgres'
import { RESERVED_SUB_RE } from '@wikistead/hooks'

const KEEP = ['tenant_dev', 'tenant_acme']

if (process.env.WIKISTEAD_TEST_STACK !== 'server-test') {
  throw new Error(
    'refusing to prune outside the isolated server-test stack (WIKISTEAD_TEST_STACK != "server-test") — ' +
      'this deletes every tenant that is not seeded, and the dev database must never see it (#269).',
  )
}

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

  const debris = (await sql<{ id: string }[]>`
    SELECT id FROM tenants WHERE id <> ALL(${KEEP})`).map((r) => r.id)

  if (debris.length === 0) {
    console.log('[prune] no leftover tenants')
  } else {
    // Which tables hang off `tenants`, asked of the database rather than listed here: a table added
    // next month joins on its own, and a list would go stale exactly when somebody is not looking.
    const children = (await sql<{ child: string }[]>`
      SELECT DISTINCT conrelid::regclass::text AS child
        FROM pg_constraint WHERE confrelid = 'tenants'::regclass AND contype = 'f'`).map((r) => r.child)

    let rows = 0
    // Children first — the foreign keys are NO ACTION, so a tenant cannot go while anything points at
    // it. One statement per table per pass: a table whose rows reference rows in another table of the
    // same set may refuse on the first pass and succeed once that one is empty.
    for (let pass = 0; pass < 4 && children.length; pass++) {
      for (const table of [...children]) {
        try {
          const r = await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [debris])
          rows += r.count ?? 0
          children.splice(children.indexOf(table), 1)
        } catch { /* still referenced — try again on the next pass */ }
      }
    }
    const gone = await sql`DELETE FROM tenants WHERE id = ANY(${debris})`
    console.log(`[prune] ${gone.count} leftover tenant(s) and ${rows} row(s) removed; ${children.length} table(s) still referenced`)
  }

  await pruneRoles(sql)
  await pruneReservedSubMembers(sql)
  await sql.end()
}

/**
 * #821: the tenants the seed owns are KEPT, so anything a test made INSIDE one of them survives every
 * prune. Role definitions are the shape that grew until it broke something: 906 of them on a stack
 * that had been running for a while, against the nought the seed makes.
 *
 * It broke by PAGING, which is why nobody noticed it growing. `/spaces/:id/assignable-roles` answers
 * with one page ordered by name, and the pin that asserts its own role is offered stops finding it
 * once 200 older ones sort ahead — reporting `expected [ 'aa667-…', …(199) ] to include 'ar-res-…'`,
 * which reads as a broken endpoint rather than as a full table. The run before it was green.
 *
 * Deleted WHOLESALE rather than by a list of test-shaped names: the seed writes no role rows at all
 * (the built-ins are constants in code, not rows), so on this stack every one of them was made by a
 * test, and a list of prefixes would go stale the first time a suite invents a new one — which is how
 * the residue sweep in seed.ts came to miss these.
 *
 * What references roles is asked of the database, for the same reason the tenant pass above asks.
 */
async function pruneRoles(sql: postgres.Sql): Promise<void> {
  const referrers = (await sql<{ child: string }[]>`
    SELECT DISTINCT conrelid::regclass::text AS child
      FROM pg_constraint WHERE confrelid = 'roles'::regclass AND contype = 'f'`).map((r) => r.child)
  let rows = 0
  for (const table of referrers) rows += (await sql.unsafe(`DELETE FROM ${table}`)).count ?? 0
  const gone = await sql`DELETE FROM roles`
  console.log(`[prune] ${gone.count} leftover role(s) and ${rows} row(s) referencing them removed ` +
    `(${referrers.length} referencing table(s) asked of the database)`)
}

/**
 * #852: member rows a killed run left inside a KEPT tenant. The suites that exercise the password
 * door create members in `tenant_dev` with subs in the reserved space (`wlocal_<uuid>` from
 * `acceptLocalInvite`, and the `wc<conn8>_` shape) and delete them in `afterAll` — so a run that is
 * cancelled leaves them, and the tenant pass above cannot help because `tenant_dev` is KEPT.
 *
 * What that costs is not tidiness. #832 measured it: the EE assertion that SCIM refuses a
 * reserved-prefix externalId proves it by counting reserved-prefix member rows in the tenant, so two
 * rows from one cancelled run turned it red on EVERY run afterwards, until somebody cleared the table
 * by hand. The message names SCIM and says nothing about debris, so it reads as a broken guard.
 *
 * SAFE TO SWEEP WHOLESALE, and this is the whole argument: the seed writes no member row with a
 * reserved sub — the subs it creates are `dev-user` and `acme-admin` — so on this stack every row
 * matching the reserved pattern was made by a test. Measured before writing this: zero such rows in a
 * freshly seeded database.
 *
 * ⚠️ It is the SECOND thing that reaches inside a kept tenant (roles, above, is the first), so the
 * promise "the prune keeps what the seed owns" now means "keeps what the seed WROTE", not "does not
 * look inside". Both exceptions have the same shape — a table the seed does not write to at all — and
 * a third one should have to argue the same way rather than inherit the licence.
 *
 * The PATTERN comes from the product (`RESERVED_SUB_RE`), not from a copy here: a prefix invented
 * next month would otherwise be swept by nothing, which is exactly how #832 happened.
 */
async function pruneReservedSubMembers(sql: postgres.Sql): Promise<void> {
  // Postgres reads the same expression the product's regex holds; `.source` keeps the two from
  // drifting apart, which a second literal would not.
  const pattern = RESERVED_SUB_RE.source
  const doomed = (await sql<{ tenant_id: string; sub: string }[]>`
    SELECT tenant_id, sub FROM members WHERE tenant_id = ANY(${KEEP}) AND sub ~ ${pattern}`)
  if (doomed.length === 0) {
    console.log('[prune] no reserved-sub member rows in the seeded tenants')
    return
  }
  // Children first, asked of the database rather than listed: `local_credentials`, `member_factors`
  // and `password_resets` point at members today, and a table added next month joins on its own.
  const referrers = (await sql<{ child: string }[]>`
    SELECT DISTINCT conrelid::regclass::text AS child
      FROM pg_constraint WHERE confrelid = 'members'::regclass AND contype = 'f'`).map((r) => r.child)
  const subs = doomed.map((r) => r.sub)
  let rows = 0
  for (const table of referrers) {
    rows += (await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1) AND member_sub = ANY($2)`, [KEEP, subs])).count ?? 0
  }
  const gone = await sql`DELETE FROM members WHERE tenant_id = ANY(${KEEP}) AND sub ~ ${pattern}`
  console.log(`[prune] ${gone.count} reserved-sub member row(s) and ${rows} row(s) referencing them removed ` +
    `from the seeded tenants (${referrers.length} referencing table(s) asked of the database)`)
}

void main()
