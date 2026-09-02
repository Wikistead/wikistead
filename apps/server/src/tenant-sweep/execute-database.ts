import type { Sql } from 'postgres'
import { deriveCascadingColumns, deriveNonCascadingColumns, derivePolymorphicTables, deriveResourceTypeTargets, type DeleteRule } from './derive.js'
import type { DoomedIds } from './manifest-keys.js'

// ADR-252 §1 / #810: the DATABASE step of a tenant:reset sweep — the first of the five stores
// (database, OpenFGA, search, storage, sessions — `tenant_sweep_progress`'s own columns, in that
// order). Everything before this file (derive.ts, manifest-keys.ts, manifest-fga.ts, doomed-ids.ts,
// write-manifest.ts) is discovery and a durable pre-write; THIS is the first statement that deletes a
// tenant's actual rows. Runs inside ONE transaction: a partial database step left half-applied is a
// worse state than not having started (some cascading rows gone, their manifest-recorded storage keys
// now unreachable from a live row, but the row that would tell an operator that is also gone).
//
// ⚠️ `extraIdentifyingColumns` / `ambiguousColumns` non-empty is FATAL, not merely test-observed
// (derive.ts's own comments, review c-a4180fb and c-af90ef9) — checked BEFORE the transaction
// opens, so an unclassifiable constraint or column refuses the whole sweep rather than silently
// omitting the one thing it couldn't reason about.
export class UnclassifiableSchemaError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`tenant-sweep refuses to run: ${reasons.length} thing(s) this walk cannot classify — ${reasons.join('; ')}`)
    this.name = 'UnclassifiableSchemaError'
  }
}

// review c-af90ef9: thrown when the manifest this run is told to act on does not match the
// tenant/operation it is being asked to run for — a wrong manifestId would otherwise sweep real rows
// and record success against progress state that belongs to a different (or no) run.
export class ManifestMismatchError extends Error {}

const REQUIRES_EXPLICIT_STATEMENT: readonly DeleteRule[] = ['no action', 'restrict', 'set default']

export async function executeDatabaseSweep(sql: Sql, manifestId: string, tenantId: string, doomed: DoomedIds): Promise<void> {
  const [manifest] = await sql<{ tenant_id: string; operation: string }[]>`
    SELECT tenant_id, operation FROM tenant_sweep_manifests WHERE id = ${manifestId}`
  if (!manifest) throw new ManifestMismatchError(`no manifest ${manifestId}`)
  if (manifest.tenant_id !== tenantId) throw new ManifestMismatchError(`manifest ${manifestId} belongs to tenant ${manifest.tenant_id}, not ${tenantId}`)
  if (manifest.operation !== 'reset') throw new ManifestMismatchError(`manifest ${manifestId} is a '${manifest.operation}' manifest, not 'reset'`)

  const { columns: cascading, extraIdentifyingColumns } = await deriveCascadingColumns(sql)
  const { columns: nonCascading, ambiguousColumns } = await deriveNonCascadingColumns(sql, cascading)
  const polymorphicTables = await derivePolymorphicTables(sql)

  // review c-af90ef9 (D7): ADR-252's own "zero tables found... is a failure" acceptance line,
  // applied to this executor itself — a derive query that regressed to matching nothing would
  // otherwise run this whole function as a silent no-op that still reports success.
  const schemaFatal: string[] = [...extraIdentifyingColumns, ...ambiguousColumns.map((c) => `${c}: a non-cascading column on a table this sweep must not row-delete`)]
  if (cascading.length === 0) schemaFatal.push('deriveCascadingColumns found zero columns — the derivation query itself is likely broken')
  if (polymorphicTables.length === 0) schemaFatal.push('derivePolymorphicTables found zero tables — the derivation query itself is likely broken')

  // 'set null' constraints need no explicit statement either — Postgres clears the column itself when
  // the referenced row goes. Only the shapes this schema doesn't use YET, and 'cascade' handled by the
  // row-delete below, are excluded from what follows; asserted rather than silently trusted, so a
  // future 'restrict'/'no action' FK on spaces/pages fails loudly instead of leaving a stale pointer.
  const needsExplicit = cascading.filter((c) => REQUIRES_EXPLICIT_STATEMENT.includes(c.deleteRule))
  for (const c of needsExplicit) schemaFatal.push(`${c.table}.${c.column}: deleteRule=${c.deleteRule} has no sweep statement written for it yet`)

  if (schemaFatal.length > 0) throw new UnclassifiableSchemaError(schemaFatal)

  // review c-af90ef9 (D2): the resource_type vocabulary is derived per table, per tenant, from
  // the ACTUAL rows about to be swept — not hardcoded to the two literals 'space'/'page' (which missed
  // watches' 'subtree' rows entirely, a silent ghost-row leak). Any value this tenant's rows use that
  // RESOURCE_TYPE_TARGETS does not recognise refuses the whole sweep, gathered across every table
  // before any DELETE runs (same "fail before touching anything" discipline as the schemaFatal check).
  const resourceTypesByTable = new Map<string, { type: string; target: 'spaces' | 'pages' | 'tenant-exempt' }[]>()
  const unknownResourceTypes: string[] = []
  for (const table of polymorphicTables) {
    const { known, unknown } = await deriveResourceTypeTargets(sql, table, tenantId)
    resourceTypesByTable.set(table, known)
    unknownResourceTypes.push(...unknown)
  }
  if (unknownResourceTypes.length > 0) throw new UnclassifiableSchemaError(unknownResourceTypes)

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
    // resource_type='tenant' rows a naive sweep would delete as collateral. One statement per
    // (table, resource_type actually present for this tenant), matched against the id set THAT type's
    // target names — never the union, never a type-only filter with no id check.
    for (const table of polymorphicTables) {
      for (const { type, target } of resourceTypesByTable.get(table) ?? []) {
        if (target === 'tenant-exempt') continue
        const ids = target === 'spaces' ? doomed.spaceIds : doomed.pageIds
        if (ids.length === 0) continue
        await tx.unsafe(`DELETE FROM ${table} WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = ANY($3)`, [tenantId, type, [...ids]])
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

    // review c-af90ef9 (D6): the row count is checked, not assumed — a manifestId that passed
    // the lookup above but whose progress row was somehow already gone (or never created) would
    // otherwise report success while updating nothing.
    const updated = await tx`UPDATE tenant_sweep_progress SET database_done = true, updated_at = now() WHERE manifest_id = ${manifestId}`
    if (updated.count !== 1) throw new ManifestMismatchError(`expected exactly one progress row for manifest ${manifestId}, updated ${updated.count}`)
  })
}
