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

// review c-a4180fb (2026-09-02, independent review of the first 4 #810 commits): the
// original shape collapsed `pg_constraint.confdeltype` (5 possible values) into a bare `cascades`
// boolean. `spaces_home_page_fk` (migration 071) is `ON DELETE SET NULL`, not `ON DELETE CASCADE` OR
// "needs an explicit DELETE" — Postgres clears the column itself. A boolean cannot say that: the false
// branch read as "the sweep must issue an explicit DELETE", which is wrong for this constraint and
// would have been wrong code the day an executor trusted it literally.
export type DeleteRule = 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action'
const DELETE_RULES: Record<string, DeleteRule> = { c: 'cascade', n: 'set null', d: 'set default', r: 'restrict', a: 'no action' }

export interface SweepColumn {
  table: string
  column: string
  target: 'spaces' | 'pages'
  /** What Postgres itself does to this column when the referenced space/page row is deleted.
   * 'cascade': the ROW is gone — the sweep only verifies zero remain, no explicit statement needed.
   * 'set null': the COLUMN is cleared automatically — likewise no explicit statement needed, but the
   *   row survives (only relevant when the row's own table isn't itself being swept for another
   *   reason).
   * 'restrict' / 'no action' / 'set default': the FK would BLOCK the parent delete outright unless
   *   this table's own doomed rows are removed first — not automatic, needs an explicit statement
   *   BEFORE the referenced row goes, not after. No constraint in this schema uses these today; a
   *   future one does, and an executor must not treat it like 'cascade'. */
  deleteRule: DeleteRule
  constraintName: string
}

// A foreign key naming a space or page always carries `tenant_id` as a co-column in this schema (the
// compound-key defence-in-depth pattern: no cross-tenant row can ever satisfy the constraint even if
// the id half collided). One constraint may therefore span more than one attribute; `attname` is
// walked in declaration order and the SINGLE non-`tenant_id` column is the identifying one. A
// constraint with more than one non-`tenant_id` column (or an unrecognised `confdeltype`) is not a
// shape this schema uses today and is reported rather than silently guessed at
// (`extraIdentifyingColumns`).
//
// ⚠️ review c-a4180fb: this array being non-empty MUST be treated as FATAL by any executor
// built on top of this function, not merely by the test suite. A constraint this walk cannot classify
// is silently absent from `columns` — an executor that only checks the test suite (which a production
// deploy does not run) would sweep every table it CAN classify and never notice the one it couldn't,
// which is exactly the silent-drop failure mode ADR-252's "zero tables found... is a failure"
// acceptance line exists to catch. No `assertNoExtraIdentifyingColumns` helper exists yet only because
// no executor calls this function yet; whichever slice writes the executor must add that guard as part
// of wiring this in, not treat the empty-array case as the only one that needs handling.
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
    const deleteRule = DELETE_RULES[r.delete_rule]
    if (!deleteRule) { extraIdentifyingColumns.push(`${r.table_name}[${r.constraint_name}]: unrecognised confdeltype ${JSON.stringify(r.delete_rule)}`); continue }
    columns.push({
      table: r.table_name,
      column: idCols[0],
      target: r.target_table === 'spaces' ? 'spaces' : 'pages',
      deleteRule,
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
//   `tenant_sweep_manifests.keep_space_ids` — this walk's OWN infrastructure (migration 135): it names
//     the keep-list, it does not point at rows to sweep. review c-a4180fb found the original
//     draft excluded this by an inline `if (table === '...')` check instead of through this list — same
//     effect, but not the "named constant with the reason next to it" shape ADR-252 asks for, and with
//     no break-check proving the exclusion does anything (unlike the api_keys entry below).
export const NAMED_EXCLUSIONS: readonly { table: string; column: string; reason: string }[] = [
  { table: 'api_keys', column: 'space_ids', reason: 'meant to go stale — migration 009: NULL = unconfined, removing an id widens the key' },
  { table: 'role_assignments', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
  { table: 'group_role_mappings', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
  { table: 'tenant_sweep_manifests', column: 'keep_space_ids', reason: "this walk's own infrastructure (migration 135) — names the keep-list, is not a row to sweep" },
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
    out.push({
      table: r.table_name,
      column: r.column_name,
      target: /space_ids?$/.test(r.column_name) ? 'spaces' : 'pages',
      deleteRule: 'no action', // no FK — Postgres does nothing; the sweep must delete explicitly
      constraintName: '', // no FK — nothing to name
    })
  }
  return out
}

// Tables carrying a (`resource_type`, `resource_id`) column pair — polymorphic, no FK possible since
// one column can't reference two tables. Derived by column-pair, not hand-listed, so a new table
// adopting the same shape joins the walk on its own. Measured today at FIVE: `role_assignments`,
// `group_role_mappings`, `share_links`, `watches`, `member_pins`. ⚠️ Only the first two are actually
// NAMED by ADR-252 §1 (their `resource_type = 'tenant'` rows are the ones a bare id-absence sweep
// would delete as collateral) — the other three are this walk's own measurement, not an ADR citation;
// said plainly here after review c-a4180fb found the original comment attributing all five
// to the ADR.
//
// ⚠️ `resource_type IN ('space', 'page')` ALONE IS NOT A SAFE PREDICATE — review c-a4180fb.
// The original version of this comment said scoping every consumer's DELETE to that type filter "is
// what keeps a tenant-tier grant safe", true for role_assignments/group_role_mappings but dangerously
// incomplete for `share_links`: §1's whole reason to exist is that a KEPT space keeps its share
// links (§0 — the demo's Hacker News URL is one). A page-type row is safe to match against the FULL
// doomed-page set (every page is swept, kept space or not — see DoomedIds in manifest-keys.ts) but a
// SPACE-type row must be matched against DOOMED SPACES ONLY, explicitly excluding the kept-space id
// even though that space's pages are being swept. Any future consumer of this table list needs BOTH
// the resource_type filter AND the correctly-scoped id set per type — the type filter alone protects
// tenant-tier grants, not a kept space's own share link.
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
