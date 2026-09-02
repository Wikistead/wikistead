import type { Sql } from 'postgres'
import { deriveCascadingColumns, deriveNonCascadingColumns, derivePolymorphicTables, type DeleteRule } from './derive.js'
import type { DoomedIds } from './manifest-keys.js'

// ADR-252 §1 / #810: the DATABASE step of a tenant:reset sweep — the first of the five stores
// (database, OpenFGA, search, storage, sessions — `tenant_sweep_progress`'s own columns, in that
// order). Everything before this file (derive.ts, manifest-keys.ts, manifest-fga.ts, doomed-ids.ts,
// write-manifest.ts) is discovery and a durable pre-write; THIS is the first statement that deletes a
// tenant's actual rows. Runs inside ONE transaction: a partial database step left half-applied is a
// worse state than not having started (some cascading rows gone, their manifest-recorded storage keys
// now unreachable from a live row, but the row that would tell an operator that is also gone).
//
// ⚠️ `extraIdentifyingColumns` non-empty is FATAL, not merely test-observed (derive.ts's own comment,
// review c-a4180fb) — checked BEFORE the transaction opens, so an unclassifiable constraint
// refuses the whole sweep rather than silently omitting the one table it couldn't reason about.
export class UnclassifiableSchemaError extends Error {
  constructor(public readonly extraIdentifyingColumns: readonly string[]) {
    super(`tenant-sweep refuses to run: ${extraIdentifyingColumns.length} constraint(s) this walk cannot classify — ${extraIdentifyingColumns.join('; ')}`)
    this.name = 'UnclassifiableSchemaError'
  }
}

const REQUIRES_EXPLICIT_STATEMENT: readonly DeleteRule[] = ['no action', 'restrict', 'set default']

export async function executeDatabaseSweep(sql: Sql, manifestId: string, tenantId: string, doomed: DoomedIds): Promise<void> {
  const { columns: cascading, extraIdentifyingColumns } = await deriveCascadingColumns(sql)
  if (extraIdentifyingColumns.length > 0) throw new UnclassifiableSchemaError(extraIdentifyingColumns)
  const nonCascading = await deriveNonCascadingColumns(sql, cascading)
  const polymorphicTables = await derivePolymorphicTables(sql)

  // 'set null' constraints need no explicit statement either — Postgres clears the column itself when
  // the referenced row goes. Only the shapes this schema doesn't use YET, and 'cascade' handled by the
  // row-delete below, are excluded from what follows; asserted rather than silently trusted, so a
  // future 'restrict'/'no action' FK on spaces/pages fails loudly instead of leaving a stale pointer.
  const needsExplicit = cascading.filter((c) => REQUIRES_EXPLICIT_STATEMENT.includes(c.deleteRule))
  if (needsExplicit.length > 0) {
    throw new UnclassifiableSchemaError(needsExplicit.map((c) => `${c.table}.${c.column}: deleteRule=${c.deleteRule} has no sweep statement written for it yet`))
  }

  await sql.begin(async (tx) => {
    // Non-cascading columns first: no FK, so order relative to the row deletes below never matters —
    // done first only so a table this walk can't otherwise reach (no cascade path at all) is cleared
    // before anything else, on the theory that failing early on the least-tested path is preferable.
    for (const col of nonCascading) {
      const ids = col.target === 'spaces' ? doomed.spaceIds : doomed.pageIds
      if (ids.length === 0) continue
      await tx.unsafe(`DELETE FROM ${col.table} WHERE tenant_id = $1 AND ${col.column} = ANY($2)`, [tenantId, [...ids]])
    }

    // Polymorphic tables: resource_type IS the discriminator a bare id-absence sweep would ignore —
    // §1's own warning (derive.ts) is that role_assignments/group_role_mappings also carry
    // resource_type='tenant' rows a naive sweep would delete as collateral. Two statements per table,
    // one per type, each matched against the id set THAT type actually names — never the union.
    for (const table of polymorphicTables) {
      if (doomed.spaceIds.length > 0) {
        await tx.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1 AND resource_type = 'space' AND resource_id = ANY($2)`, [tenantId, [...doomed.spaceIds]])
      }
      if (doomed.pageIds.length > 0) {
        await tx.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1 AND resource_type = 'page' AND resource_id = ANY($2)`, [tenantId, [...doomed.pageIds]])
      }
    }

    // Pages: explicit and total (every page reset empties, kept space or not — the corrected §1
    // semantics). Cascading columns (attachments, revisions, ...) go with their page automatically;
    // spaces.home_page_id is cleared automatically (ON DELETE SET NULL) for whichever space, kept or
    // doomed, pointed at a page being deleted here.
    if (doomed.pageIds.length > 0) {
      await tx`DELETE FROM pages WHERE tenant_id = ${tenantId} AND id = ANY(${[...doomed.pageIds]})`
    }
    // Spaces: ONLY the doomed ones. By the time this runs every page is already gone (including any
    // doomed space's pages, deleted above like everyone else's), so this never fires a cascade — it is
    // here for the SPACE ROW ITSELF, which nothing above touches.
    if (doomed.spaceIds.length > 0) {
      await tx`DELETE FROM spaces WHERE tenant_id = ${tenantId} AND id = ANY(${[...doomed.spaceIds]})`
    }

    await tx`UPDATE tenant_sweep_progress SET database_done = true, updated_at = now() WHERE manifest_id = ${manifestId}`
  })
}
