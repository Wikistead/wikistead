import type { Sql } from 'postgres'

// ADR-252 §1 ("Empty a workspace — tenant:reset") / #810: which rows a reset (or, inheriting this
// path, a removal) must touch when it empties a space or page. NOT the whole-tenant table set §"Both
// operations" derives (FK-reachable from `tenants` UNION every `tenant_id`-column table, ADR-252's
// removal-only derivation) — this is narrower: tables that name a SPACE or a PAGE specifically, so a
// keep-listed space's untouched siblings are never candidates in the first place.
//
// "The predicate per table is read from the schema, not guessed from the column name" (ADR-252 §1):
// every shape below is measured against `pg_constraint` / `information_schema`, never hand-listed —
// a table added next month with a `page_id` column joins the derivation on its own, the way
// `prune-test-tenants.ts` (#788) already does for the whole-tenant case.

export interface SweepColumn {
  table: string
  column: string
  target: 'spaces' | 'pages'
  /** ON DELETE CASCADE — the row already vanishes once its space/page is deleted; the sweep only
   * verifies zero remain, it does not need to issue the DELETE itself. */
  cascades: boolean
  constraintName: string
}

// A foreign key naming a space or page always carries `tenant_id` as a co-column in this schema (the
// compound-key defence-in-depth pattern: no cross-tenant row can ever satisfy the constraint even if
// the id half collided). One constraint may therefore span more than one attribute; `attname` is
// walked in declaration order and the SINGLE non-`tenant_id` column is the identifying one. A
// constraint with more than one non-`tenant_id` column is not a shape this schema uses today and is
// reported rather than silently guessed at (`extraIdentifyingColumns`), so a future one that broke the
// assumption fails loudly instead of picking a column at random.
export async function deriveCascadingColumns(sql: Sql): Promise<{ columns: SweepColumn[]; extraIdentifyingColumns: string[] }> {
  const rows = await sql<{
    constraint_name: string
    table_name: string
    target_table: string
    delete_rule: string
    columns: string[]
  }[]>`
    SELECT
      con.conname AS constraint_name,
      con.conrelid::regclass::text AS table_name,
      con.confrelid::regclass::text AS target_table,
      con.confdeltype AS delete_rule,
      array_agg(att.attname ORDER BY ck.ord) AS columns
    FROM pg_constraint con
    JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
    WHERE con.contype = 'f' AND con.confrelid IN ('spaces'::regclass, 'pages'::regclass)
    GROUP BY con.conname, con.conrelid, con.confrelid, con.confdeltype
    ORDER BY table_name, constraint_name`

  const columns: SweepColumn[] = []
  const extraIdentifyingColumns: string[] = []
  for (const r of rows) {
    const idCols = r.columns.filter((c) => c !== 'tenant_id')
    if (idCols.length !== 1) {
      extraIdentifyingColumns.push(`${r.table_name}[${r.constraint_name}]: ${r.columns.join(',')}`)
      continue
    }
    columns.push({
      table: r.table_name,
      column: idCols[0],
      target: r.target_table === 'spaces' ? 'spaces' : 'pages',
      cascades: r.delete_rule === 'c',
      constraintName: r.constraint_name,
    })
  }
  return { columns, extraIdentifyingColumns }
}

// Named, not derived: a table has no way to say in its schema "I hold an id that is ALLOWED to go
// stale" versus "I hold one that must be swept" — that is a product decision ADR-252 §1 makes for two
// specific columns, and it says so:
//   `api_keys.space_ids` — the migration's own comment says NULL/[] carry meaning (unconfined /
//     confined-to-nothing) and removing an id from the array does not tidy anything, it silently
//     WIDENS the key's reach. Reset leaves it alone, deliberately.
//   `role_assignments` / `group_role_mappings` — polymorphic (`resource_type` + `resource_id`); see
//     POLYMORPHIC_TABLES below. Named here too so a column-name walk over `*_id`-shaped text columns
//     does not also propose sweeping them by bare id absence, which would delete tenant-tier grants.
export const NAMED_EXCLUSIONS: readonly { table: string; column: string; reason: string }[] = [
  { table: 'api_keys', column: 'space_ids', reason: 'meant to go stale — migration 009: NULL = unconfined, removing an id widens the key' },
  { table: 'role_assignments', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
  { table: 'group_role_mappings', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
]

// Columns that NAME a space or page (by column-naming convention, `information_schema`-derived) but
// carry NO foreign key — a plain TEXT id to a row the sweep is about to make not-exist. These need an
// EXPLICIT delete (`WHERE column = ANY(swept ids)`); nothing cascades them away.
export async function deriveNonCascadingColumns(sql: Sql, cascading: readonly SweepColumn[]): Promise<SweepColumn[]> {
  // `s?$` (not just `$`): `api_keys.space_ids` is plural — the ADR names it explicitly as a column
  // this walk MUST find and then exclude by name, not as one the pattern should quietly miss. An
  // anchor without the plural would make NAMED_EXCLUSIONS' api_keys entry vacuous (nothing to exclude
  // because nothing ever matched) — caught by this file's own break-check test.
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND (column_name ~ 'page_ids?$' OR column_name ~ 'space_ids?$')
    ORDER BY table_name, column_name`

  const cascadingKeys = new Set(cascading.map((c) => `${c.table}.${c.column}`))
  const excludedKeys = new Set(NAMED_EXCLUSIONS.map((e) => `${e.table}.${e.column}`))
  const out: SweepColumn[] = []
  for (const r of rows) {
    const key = `${r.table_name}.${r.column_name}`
    if (cascadingKeys.has(key) || excludedKeys.has(key)) continue
    if (r.table_name === 'tenant_sweep_manifests') continue // the manifest names its own keep-list, not a row to sweep
    out.push({
      table: r.table_name,
      column: r.column_name,
      target: /space_ids?$/.test(r.column_name) ? 'spaces' : 'pages',
      cascades: false,
      constraintName: '', // no FK — nothing to name
    })
  }
  return out
}

// The five tables ADR-252 §1 names as polymorphic (`resource_type` + `resource_id`, no FK possible
// since one column can't reference two tables). Derived by column-pair, not hand-listed, so a sixth
// table adopting the same shape joins the walk on its own — but the ADR's warning about
// `role_assignments` / `group_role_mappings` (they also carry `resource_type = 'tenant'` rows, which a
// bare id-absence sweep would delete as collateral) means every consumer of this list MUST scope its
// DELETE to `resource_type IN ('space', 'page')`, never to id-absence alone. That predicate shape,
// not a per-table exception, is what keeps a tenant-tier grant safe.
export async function derivePolymorphicTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'resource_type'
      AND table_name IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'resource_id')
    ORDER BY table_name`
  return rows.map((r) => r.table_name)
}
