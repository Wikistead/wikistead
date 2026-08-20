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

void main()
