import type { Queryable } from './derive.js'
import { UnclassifiableSchemaError } from './execute-database.js'

// ADR-252 §1 / "Both operations" / #810: the storage keys `tenant_sweep_manifests.storage_keys` must
// hold before a reset destroys anything — "every S3 key a swept row points at", derived from the
// KEY-BEARING COLUMNS, not from a key shape that happens to embed the tenant id (rev 4's rule, replaced
// in rev 5: space icons and member avatars do not carry the tenant id in their key text).
//
// Scoped to §1 (tenant:reset) specifically, not the full 7-column list "Both operations" names for
// BOTH operations combined. `members.avatar_image_key` and `tenant_settings.logo_key` are excluded
// here: a reset keeps the tenant's members and its own settings row (§1's decision — "keeps its row,
// its slug, its members, its login configuration"), so neither survives a delete in the first place.
// A future §2 (full removal) slice adds those two when it is built; naming them here as "not yet
// wired" rather than silently omitting them keeps the gap visible.

export interface DoomedIds {
  // ⚠️ §1: "for a kept space it keeps the space, its settings, and its share links; it EMPTIES THE
  // PAGES INSIDE" — a kept space's pages are swept too. `spaceIds` and `pageIds` are therefore NOT
  // the same "which spaces are doomed" filter applied twice; they answer two different questions.
  /** spaces NOT on the keep-list — the SPACE ROW (and `space_settings`, its icon key) is swept.
   * A kept space's own id does not belong here even though its pages do belong in `pageIds` below. */
  spaceIds: readonly string[]
  /** EVERY page reset empties — every space's pages, keep-listed or not. A kept space keeps its row
   * and settings, never its pages. */
  pageIds: readonly string[]
}

// review c-af763a4 (4th pass, F4): ADR-252's own Acceptance requires storage keys be "derived
// from the key-bearing COLUMNS... the count of columns is printed" — this file's four SELECTs below
// were hand-authored against TODAY's schema, with no query anywhere confirming that hand-authored set
// still matches what the schema actually holds. A ninth `_key` column landing in a future migration
// would join neither this file's coverage nor any error — the exact silent-drop shape ADR-252's own
// "zero tables found... is a failure" line exists to catch, just one layer up (columns, not tables).
//
// Not a bare `_key$` name match: measured live against this schema, that pattern also catches
// `email_outbox.fold_key` (a dedup/collapse key, migration 089 §6), `member_passkeys.public_key` (a
// WebAuthn COSE key, migration 119) and `space_settings`/`tenant_settings.accent_key` (a branding
// color token, migrations 018/019) — none of them point at a storage object. Named, with the reason
// next to each, the same shape as derive.ts's own `NAMED_EXCLUSIONS`.
export const STORAGE_KEY_NAMED_EXCLUSIONS: readonly { table: string; column: string; reason: string }[] = [
  { table: 'email_outbox', column: 'fold_key', reason: 'a dedup/collapse key for queued email (migration 089 §6), not a storage pointer' },
  { table: 'member_passkeys', column: 'public_key', reason: 'a WebAuthn COSE public key (migration 119), not a storage pointer' },
  { table: 'space_settings', column: 'accent_key', reason: 'a branding accent-color token (migration 018), not a storage pointer' },
  { table: 'tenant_settings', column: 'accent_key', reason: 'a branding accent-color token (migration 019), not a storage pointer' },
]

// The four columns `collectResetStorageKeys` below actually queries today.
const RESET_COVERED_STORAGE_KEY_COLUMNS: ReadonlySet<string> = new Set([
  'attachments.s3_key',
  'imports.archive_key',
  'revisions.ydoc_key',
  'space_settings.icon_image_key',
])

// The columns this file's own header comment already names as deliberately NOT queried by a reset —
// `members.avatar_image_key` / `tenant_settings.logo_key` survive because §1 keeps members and tenant
// settings; `revision_gc_candidates.ydoc_key` is excluded for the reasons the big comment below gives
// (no tenant_id, no page linkage). Named here too so this derivation's `unknown` list stays empty for
// columns this file already made a deliberate decision about, rather than flagging its own documented
// exclusions as newly-unclassifiable.
const RESET_DEFERRED_STORAGE_KEY_COLUMNS: ReadonlySet<string> = new Set([
  'members.avatar_image_key',
  'tenant_settings.logo_key',
  'revision_gc_candidates.ydoc_key',
])

export async function deriveStorageKeyColumns(sql: Queryable): Promise<{ covered: string[]; deferred: string[]; unknown: string[] }> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name ~ '_key$'
    ORDER BY table_name, column_name`

  const excludedKeys = new Set(STORAGE_KEY_NAMED_EXCLUSIONS.map((e) => `${e.table}.${e.column}`))
  const covered: string[] = []
  const deferred: string[] = []
  const unknown: string[] = []
  for (const r of rows) {
    const key = `${r.table_name}.${r.column_name}`
    if (excludedKeys.has(key)) continue
    if (RESET_COVERED_STORAGE_KEY_COLUMNS.has(key)) { covered.push(key); continue }
    if (RESET_DEFERRED_STORAGE_KEY_COLUMNS.has(key)) { deferred.push(key); continue }
    unknown.push(key)
  }
  return { covered, deferred, unknown }
}

export async function collectResetStorageKeys(sql: Queryable, tenantId: string, doomed: DoomedIds): Promise<string[]> {
  // Checked before any SELECT below runs: an unclassified `_key` column refuses the whole manifest
  // write rather than silently shipping a manifest that is missing whatever that column points at.
  const { covered, unknown } = await deriveStorageKeyColumns(sql)
  if (unknown.length > 0) throw new UnclassifiableSchemaError(unknown)
  if (covered.length !== RESET_COVERED_STORAGE_KEY_COLUMNS.size) {
    throw new UnclassifiableSchemaError([`deriveStorageKeyColumns found ${covered.length} covered column(s), expected ${RESET_COVERED_STORAGE_KEY_COLUMNS.size} — the derivation query itself is likely broken`])
  }

  const keys: string[] = []

  if (doomed.pageIds.length > 0) {
    const attachments = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM attachments WHERE tenant_id = ${tenantId} AND page_id = ANY(${doomed.pageIds})`
    keys.push(...attachments.map((r) => r.s3_key))

    const revisions = await sql<{ ydoc_key: string }[]>`
      SELECT ydoc_key FROM revisions
      WHERE tenant_id = ${tenantId} AND page_id = ANY(${doomed.pageIds}) AND ydoc_key IS NOT NULL`
    keys.push(...revisions.map((r) => r.ydoc_key))
  }

  if (doomed.spaceIds.length > 0) {
    const icons = await sql<{ icon_image_key: string }[]>`
      SELECT icon_image_key FROM space_settings
      WHERE tenant_id = ${tenantId} AND space_id = ANY(${doomed.spaceIds}) AND icon_image_key IS NOT NULL`
    keys.push(...icons.map((r) => r.icon_image_key))
  }

  // ⚠️ review c-af90ef9 (independent review of execute-database.ts, 2026-09-02): the
  // executor's non-cascading sweep deletes EVERY column derive.ts finds by its own column-level
  // `target` — for `imports`, that is TWO separate DELETE statements (`space_id = ANY(doomed.spaceIds)`
  // AND `parent_page_id = ANY(doomed.pageIds)`, since both columns are independently non-cascading).
  // The version of this query gated on `doomed.spaceIds.length > 0` alone (and only ever read
  // `space_id`) therefore missed archive_key for an import whose ONLY doomed reference was its
  // `parent_page_id` — reproduced live: a queued import in a KEPT space targeting that space's (also
  // swept) page was deleted with its archive_key never manifested, an unreachable S3 blob. The union
  // below is not a guess — it matches execute-database.ts's own two DELETE predicates for this table
  // exactly, which is the contract manifest-keys.ts already existed to keep (this file's whole job is
  // "record every key a row the sweep is about to touch points at").
  if (doomed.spaceIds.length > 0 || doomed.pageIds.length > 0) {
    const archives = await sql<{ archive_key: string }[]>`
      SELECT archive_key FROM imports
      WHERE tenant_id = ${tenantId}
        AND (space_id = ANY(${[...doomed.spaceIds]}) OR parent_page_id = ANY(${[...doomed.pageIds]}))
        AND archive_key IS NOT NULL`
    keys.push(...archives.map((r) => r.archive_key))
  }

  // ⚠️ `revision_gc_candidates` (migration 034) is DELIBERATELY NOT queried here, even though ADR-252
  // names its `ydoc_key` column. That table has no `tenant_id` column at all (it is admin/GC-internal
  // bookkeeping, keyed only by the storage key text — `revisions/${tenantId}/${uuid}`, revision-ydoc.ts)
  // and carries no page linkage — a row in it is, by construction, a blob whose live `revisions` row is
  // ALREADY GONE, and that linkage is what a KEEP-LIST reset would need to tell a kept space's orphaned
  // history apart from a doomed one's — lost the moment the row became a candidate. Sweeping it here
  // would over-reach into a kept space's history.
  // ⚠️ review c-a4180fb corrected the original "runs independently on its own schedule" claim
  // here — measured against `deploy/k8s/**`: the only CronJobs in this tree are `scim-reconcile` and
  // `backup`; `revisions:gc` (package.json) is a manual `pnpm revisions:gc`, run by nobody automatically.
  // Leaving this table alone is still the right call — sweeping it here risks the over-reach above,
  // where it stands it is merely UNCOLLECTED rather than unrecoverable (an operator can still run it) —
  // but "not unsafely, because it runs on its own schedule" overstated what actually happens today.
  // A whole-tenant removal (§2, not yet built) has no keep-list ambiguity — every row is doomed — and
  // can safely prefix-match `revisions/${tenantId}/%` when it is implemented.
  return keys
}
