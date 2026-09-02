// ADR-252 §1 / #810: the schema-derived table set a tenant:reset (or, inheriting this path, a
// removal) must sweep when it empties a space or page. Integration (real Postgres) — the whole point
// of "derived, not guessed" is that it reads the LIVE schema, so a fixture database proves nothing a
// hand-written list wouldn't already have proven.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { deriveCascadingColumns, deriveNonCascadingColumns, derivePolymorphicTables, deriveResourceTypeTargets, NAMED_EXCLUSIONS } from '../tenant-sweep/derive.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)

describe('tenant-sweep schema derivation (ADR-252 §1, #810)', () => {
  it('finds a non-zero cascading set, with no constraint reporting more than one identifying column', async () => {
    const { columns, extraIdentifyingColumns } = await deriveCascadingColumns(admin)
    console.log(`[derive] cascading columns: ${columns.length}`)
    expect(columns.length, 'zero cascading columns is a failure, not an empty schema').toBeGreaterThan(0)
    expect(extraIdentifyingColumns, 'a constraint with >1 non-tenant_id column needs a human, not a guess').toEqual([])
    // spot-check a few well-known cascades rather than the whole list — the whole list is what the
    // count above already proves is non-empty and schema-derived
    expect(columns).toContainEqual(expect.objectContaining({ table: 'pages', column: 'space_id', target: 'spaces', deleteRule: 'cascade' }))
    expect(columns).toContainEqual(expect.objectContaining({ table: 'attachments', column: 'page_id', target: 'pages', deleteRule: 'cascade' }))
    // spaces.home_page_id is a real FK to pages that is ON DELETE SET NULL (migration 071) — the space
    // row survives a reset and Postgres clears the pointer itself, which is neither 'cascade' (the row
    // isn't gone) nor a shape needing an explicit sweep statement (the column isn't left dangling
    // either) — review c-a4180fb found the original 'cascades: false' collapsed this into the
    // same bucket as a column that genuinely does need an explicit DELETE.
    expect(columns).toContainEqual(expect.objectContaining({ table: 'spaces', column: 'home_page_id', deleteRule: 'set null' }))
  })

  it('finds a non-zero non-cascading set, excluding the named exclusions and the cascading set, with zero ambiguous columns today', async () => {
    const { columns: cascading } = await deriveCascadingColumns(admin)
    const { columns: nonCascading, ambiguousColumns } = await deriveNonCascadingColumns(admin, cascading)
    console.log(`[derive] non-cascading columns: ${nonCascading.length}`)
    expect(nonCascading.length, 'zero non-cascading columns is a failure').toBeGreaterThan(0)
    expect(ambiguousColumns, "today's schema has no non-cascading column on spaces/pages/tenants — see the break-check below for what it looks like when it does").toEqual([])
    for (const c of nonCascading) expect(c.deleteRule).toBe('no action')
    // the exclusions actually exclude something real, not a name that never matched
    expect(nonCascading.find((c) => c.table === 'api_keys' && c.column === 'space_ids')).toBeUndefined()
    expect(nonCascading.find((c) => c.table === 'templates' && c.column === 'space_id')).toBeUndefined()
    expect(nonCascading.find((c) => c.table === 'templates' && c.column === 'source_page_id')).toBeUndefined()
    // a genuine stray TEXT id with no FK is still found (proves the walk isn't only finding FK'd ones,
    // and isn't just excluding everything) — imports.space_id has no FK (migration 124: the column is
    // plain TEXT, only tenant_id has one) and is not a named exclusion
    expect(nonCascading).toContainEqual(expect.objectContaining({ table: 'imports', column: 'space_id' }))
  })

  // ⚠️ break-check (review c-af90ef9, D3): prove SURVIVING_TABLES actually catches the case it
  // exists for. Drops `spaces_home_page_fk` inside a transaction that always ROLLS BACK — the schema is
  // never actually changed — and re-runs the walk against that transaction's connection to see what it
  // would have found had the FK genuinely been dropped (e.g. by a future migration).
  it('⚠️ break-check: without spaces_home_page_fk, home_page_id would be a non-cascading column on spaces — caught as ambiguous, not swept', async () => {
    await admin.begin(async (tx) => {
      await tx`ALTER TABLE spaces DROP CONSTRAINT spaces_home_page_fk`
      const { columns: cascadingInTx } = await deriveCascadingColumns(tx)
      const { columns: nonCascadingInTx, ambiguousColumns } = await deriveNonCascadingColumns(tx, cascadingInTx)
      expect(nonCascadingInTx.find((c) => c.table === 'spaces' && c.column === 'home_page_id'),
        'without the guard, this would be swept by ROW DELETION — deleting a KEPT space').toBeUndefined()
      expect(ambiguousColumns).toContain('spaces.home_page_id')
      throw new Error('rollback — never commit the dropped constraint') // sql.begin rolls back on throw
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'rollback — never commit the dropped constraint') throw e
    })
    // confirm the schema is genuinely unchanged after the rollback
    const [restored] = await admin<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conname = 'spaces_home_page_fk'`
    expect(restored, 'the constraint must still exist — this test must never leave the schema mutated').toBeDefined()
  })

  // ⚠️ break-check: prove every named exclusion is removing a column that is actually there —
  // without this, a typo'd exclusion (e.g. excluding a column name that no longer exists) would pass
  // the test above vacuously, the exact failure mode this project's memory calls "an exemption must
  // name someone who actually has it". Table-driven so templates' two entries get the same proof
  // api_keys already had, not a one-off.
  it.each(NAMED_EXCLUSIONS)('⚠️ break-check: $table.$column exists in the raw column walk the exclusion is filtering', async ({ table, column }) => {
    const raw = await admin<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`
    expect(raw.length, 'the excluded column must actually exist, or the exclusion excludes nothing').toBe(1)
  })

  it('finds all five (resource_type, resource_id) tables measured today — only 2 of which the ADR itself names', async () => {
    const tables = await derivePolymorphicTables(admin)
    console.log(`[derive] polymorphic tables: ${tables.length}`)
    expect(tables.length, 'zero polymorphic tables is a failure').toBeGreaterThan(0)
    expect(tables.sort()).toEqual(['group_role_mappings', 'member_pins', 'role_assignments', 'share_links', 'watches'])
    // the two ADR-252 §1 names explicitly (the tenant-tier-grant collateral-damage warning)
    expect(tables).toEqual(expect.arrayContaining(['role_assignments', 'group_role_mappings']))
  })

  describe('deriveResourceTypeTargets (D2, review c-af90ef9)', () => {
    const TENANT = 'tenant_t810rt'
    afterAll(async () => {
      await admin.unsafe(`DELETE FROM watches WHERE tenant_id = '${TENANT}'`).catch(() => {})
      await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
    })

    it("maps a 'subtree' watch to the 'pages' target — resource_id is a page id (notifications.ts's own comment)", async () => {
      await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810rt', 'business')
        ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
      await admin`INSERT INTO watches (id, tenant_id, member_sub, resource_type, resource_id)
        VALUES ('w_t810rt_subtree', ${TENANT}, 'dev-user', 'subtree', 'page_t810rt_ancestor')
        ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO watches (id, tenant_id, member_sub, resource_type, resource_id)
        VALUES ('w_t810rt_space', ${TENANT}, 'dev-user', 'space', 'space_t810rt')
        ON CONFLICT (id) DO NOTHING`

      const { known, unknown } = await deriveResourceTypeTargets(admin, 'watches', TENANT)
      expect(unknown).toEqual([])
      expect(known.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
        { type: 'space', target: 'spaces' },
        { type: 'subtree', target: 'pages' },
      ])
    })

    it('a tenant with no rows in a polymorphic table gets an empty (not fatal) result', async () => {
      const { known, unknown } = await deriveResourceTypeTargets(admin, 'member_pins', TENANT)
      expect(known).toEqual([])
      expect(unknown).toEqual([])
    })

    it('a value present in RESOURCE_TYPE_TARGETS never appears in `unknown`', async () => {
      const { unknown } = await deriveResourceTypeTargets(admin, 'watches', TENANT)
      expect(unknown).toEqual([])
    })
  })
})
