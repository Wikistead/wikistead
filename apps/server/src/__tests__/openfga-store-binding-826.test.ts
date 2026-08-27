// ADR-253 §3.4 & §6: the witness table's shape, measured — not just written.
//
// The whole point of this table is that it answers before any tenant exists, on a connection that
// sets no app.tenant_id. A table that RLS hides answers "never had a store" there, which is the
// fail-open #479 already burned this repo for once (a FORCE-RLS'd table matching zero rows under the
// bare pool, silently) — the same handle rule, needed here for the opposite reason: this table MUST
// be readable bare, so its absence of RLS is asserted directly rather than assumed from its migration.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { pool } from '../db/pool.js'

const ROOT = resolve(import.meta.dirname, '../../../..')
const MIGRATIONS_DIR = join(ROOT, 'infra/db/migrations')

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

afterEach(async () => {
  await pool`DELETE FROM openfga_store_binding`.catch(() => {})
})

describe('ADR-253 §3.4 the openfga_store_binding witness table', () => {
  it('is granted every verb resolution, rotate, and the forget command need', () => {
    const sql = migrationSql()
    expect(sql, 'migration for the witness table not found').toMatch(/CREATE TABLE IF NOT EXISTS openfga_store_binding/)
    const grantLine = sql.match(/GRANT ([^;]+) ON TABLE openfga_store_binding TO app;/)?.[1]
    expect(grantLine, 'no GRANT line for openfga_store_binding').toBeTruthy()
    for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(grantLine, `missing ${verb} — a write verb this design uses would fail`).toContain(verb)
    }
  })

  it('carries no row-level security — deliberately, unlike every tenant-scoped table', () => {
    const sql = migrationSql()
    expect(sql).not.toMatch(/ALTER TABLE openfga_store_binding ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/ALTER TABLE openfga_store_binding FORCE ROW LEVEL SECURITY/)
  })

  it('is readable and writable on the bare pool with no tenant context set', async () => {
    // The runtime role, no app.tenant_id — exactly the connection shape resolution runs on, since
    // resolution happens before any tenant exists.
    await pool`INSERT INTO openfga_store_binding (store_id) VALUES ('store-826-test')`
    const rows = await pool<{ store_id: string }[]>`SELECT store_id FROM openfga_store_binding`
    expect(rows, 'a FORCE-RLS table would answer zero rows here — that is the fail-open this pin exists to catch').toHaveLength(1)
    expect(rows[0]!.store_id).toBe('store-826-test')
  })

  it('is a single row, enforced rather than assumed: a second id cannot even be inserted', async () => {
    await pool`INSERT INTO openfga_store_binding (id, store_id) VALUES ('singleton', 'store-a')`
    await expect(
      pool`INSERT INTO openfga_store_binding (id, store_id) VALUES ('another-id', 'store-b')`,
    ).rejects.toThrow()
  })

  it('the same row can be updated (the rotate path) and deleted (the forget command)', async () => {
    await pool`INSERT INTO openfga_store_binding (store_id) VALUES ('store-before-rotate')`
    await pool`UPDATE openfga_store_binding SET store_id = 'store-after-rotate' WHERE id = 'singleton'`
    const [row] = await pool<{ store_id: string }[]>`SELECT store_id FROM openfga_store_binding`
    expect(row?.store_id).toBe('store-after-rotate')

    await pool`DELETE FROM openfga_store_binding WHERE id = 'singleton'`
    const afterDelete = await pool`SELECT 1 FROM openfga_store_binding`
    expect(afterDelete).toHaveLength(0)
  })
})
