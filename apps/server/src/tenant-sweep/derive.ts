import type { Sql, TransactionSql } from 'postgres'

// Accepts a transaction handle too: the derive functions issue only read queries (the tag template /
// .unsafe()), which both types support identically — TransactionSql merely lacks lifecycle methods
// (.end() etc.) Sql has, which these functions never call. Needed so a caller can run a derive query
// INSIDE a transaction it controls (e.g. a break-check that drops and rolls back a constraint) without
// a separate, narrower signature for that one case.
export type Queryable = Sql | TransactionSql

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
export async function deriveCascadingColumns(sql: Queryable): Promise<{ columns: SweepColumn[]; extraIdentifyingColumns: string[] }> {
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
//   `templates.space_id` / `templates.source_page_id` — migration 051's own column comments settle
//     the "does a kept space's template get swept along with its (also swept) pages" question this
//     directory had left open (an earlier commit's manifest-fga.ts explicitly flagged it as
//     unresolved): "`body_md` — frozen snapshot of the source page's published_md", "`source_page_id`
//     — provenance ONLY: no FK / no cascade (source may be edited/deleted)", "`space_id` — no FK
//     action (space delete degrades to owner/admin visibility, snapshot stays)". A template is a
//     self-contained snapshot BY DESIGN, deliberately built to survive its source page or space being
//     gone — the same "meant to go stale" shape as api_keys.space_ids, not a row this sweep should
//     touch. Found by re-reading the schema while resolving the open question, not guessed at: the
//     original (unreviewed) version of this file's own test asserted the OPPOSITE — that
//     templates.space_id belonged in the swept set — which this correction also fixes.
export const NAMED_EXCLUSIONS: readonly { table: string; column: string; reason: string }[] = [
  { table: 'api_keys', column: 'space_ids', reason: 'meant to go stale — migration 009: NULL = unconfined, removing an id widens the key' },
  { table: 'role_assignments', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
  { table: 'group_role_mappings', column: 'resource_id', reason: 'polymorphic — swept via resource_type, see POLYMORPHIC_TABLES' },
  { table: 'tenant_sweep_manifests', column: 'keep_space_ids', reason: "this walk's own infrastructure (migration 135) — names the keep-list, is not a row to sweep" },
  { table: 'templates', column: 'space_id', reason: 'migration 051: "no FK action (space delete degrades to owner/admin visibility, snapshot stays)" — a template is a frozen, self-contained snapshot by design' },
  { table: 'templates', column: 'source_page_id', reason: 'migration 051: "provenance ONLY: no FK / no cascade (source may be edited/deleted)" — same snapshot design as space_id above' },
]

// Tables this walk must NEVER treat a non-cascading column as "delete the row" for — they are the
// entities the sweep exists to selectively PRESERVE (a kept space's own row; every page's own row is
// handled by execute-database.ts's dedicated page-delete step, not this generic mechanism; a tenant
// never goes under §1 at all). review c-af90ef9 found this gap by dropping
// `spaces_home_page_fk` inside a rolled-back transaction and re-running this walk: with that one FK
// gone, `spaces.home_page_id` would be picked up here and swept by ROW DELETION — an executor built on
// the (until-now-untested) assumption "every non-cascading column means delete the row" would delete a
// KEPT space outright the day that FK changed shape, with no test anywhere failing first.
const SURVIVING_TABLES: ReadonlySet<string> = new Set(['spaces', 'pages', 'tenants'])

// Columns that NAME a space or page (by column-naming convention, `information_schema`-derived) but
// carry NO foreign key — a plain TEXT id to a row the sweep is about to make not-exist. These need an
// EXPLICIT delete (`WHERE column = ANY(swept ids)`); nothing cascades them away. A column found on one
// of `SURVIVING_TABLES` is reported as `ambiguousColumns` instead of swept — this walk cannot safely
// guess whether such a column means "delete this row" (wrong, for a table the sweep must preserve) or
// something narrower a human needs to design.
export async function deriveNonCascadingColumns(sql: Queryable, cascading: readonly SweepColumn[]): Promise<{ columns: SweepColumn[]; ambiguousColumns: string[] }> {
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
  const columns: SweepColumn[] = []
  const ambiguousColumns: string[] = []
  for (const r of rows) {
    const key = `${r.table_name}.${r.column_name}`
    if (cascadingKeys.has(key) || excludedKeys.has(key)) continue
    if (SURVIVING_TABLES.has(r.table_name)) { ambiguousColumns.push(key); continue }
    columns.push({
      table: r.table_name,
      column: r.column_name,
      target: /space_ids?$/.test(r.column_name) ? 'spaces' : 'pages',
      deleteRule: 'no action', // no FK — Postgres does nothing; the sweep must delete explicitly
      constraintName: '', // no FK — nothing to name
    })
  }
  return { columns, ambiguousColumns }
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
export async function derivePolymorphicTables(sql: Queryable): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'resource_type'
      AND table_name IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'resource_id')
    ORDER BY table_name`
  return rows.map((r) => r.table_name)
}

// review c-af90ef9: `execute-database.ts` originally hardcoded the two literals 'space' and
// 'page' as the whole `resource_type` vocabulary for every polymorphic table — wrong for `watches`
// (migration 067's own CHECK constraint: `resource_type IN ('page', 'space', 'subtree')`). A 'subtree'
// watch's `resource_id` is a PAGE id (`routes/notifications.ts`'s own comments, twice: "a 'subtree'
// watch targets a PAGE id (the ancestor)" and "subtree anchors are pages") — so it was silently never
// swept, surviving reset as a ghost pointing at a page that no longer exists.
//
// Named, not derived from a CHECK constraint alone: `member_pins` restricts to {space, page} (a real
// CHECK) but `role_assignments`, `group_role_mappings` and `share_links` carry NO CHECK at all — the
// domain is enforced in application code, not the schema, so there is nothing to introspect for those
// three. The map below is therefore the same shape as NAMED_EXCLUSIONS: named, with the reason next to
// each entry, checked against what a TENANT'S ACTUAL ROWS use at sweep time (not what the schema
// merely permits) — `deriveResourceTypeTargets` below queries live data and treats any value NOT in
// this map as fatal, so a resource_type this table can hold but this map doesn't yet know about (a new
// CHECK value, or free-text drift on the three unchecked tables) refuses the sweep instead of silently
// leaving rows behind the way the hardcoded literals did.
export const RESOURCE_TYPE_TARGETS: Readonly<Record<string, 'spaces' | 'pages' | 'tenant-exempt'>> = {
  space: 'spaces',
  page: 'pages',
  subtree: 'pages', // notifications.ts: "subtree anchors are pages" — resource_id is the ancestor page's id
  tenant: 'tenant-exempt', // role_assignments / group_role_mappings — the collateral-damage case §1 warns about
}

// For ONE polymorphic table, the resource_type values THIS TENANT'S rows actually use, each mapped to
// its sweep target — plus any value not in `RESOURCE_TYPE_TARGETS` (fatal for the caller to check).
// Per-tenant (not schema-wide) deliberately: a table with none of this tenant's rows in it needs no
// vocabulary check at all, and a schema-wide `SELECT DISTINCT` would still miss a value only used by a
// tenant nobody has swept yet — the guarantee this function gives is "every value THIS sweep is about
// to act on is one it knows how to act on", not "every value this table could ever hold".
export async function deriveResourceTypeTargets(sql: Queryable, table: string, tenantId: string): Promise<{ known: { type: string; target: 'spaces' | 'pages' | 'tenant-exempt' }[]; unknown: string[] }> {
  const rows = await sql.unsafe<{ resource_type: string }[]>(
    `SELECT DISTINCT resource_type FROM ${table} WHERE tenant_id = $1`, [tenantId],
  )
  const known: { type: string; target: 'spaces' | 'pages' | 'tenant-exempt' }[] = []
  const unknown: string[] = []
  for (const r of rows) {
    const target = RESOURCE_TYPE_TARGETS[r.resource_type]
    if (target) known.push({ type: r.resource_type, target })
    else unknown.push(`${table}.resource_type = ${JSON.stringify(r.resource_type)}`)
  }
  return { known, unknown }
}
