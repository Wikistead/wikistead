// #988: the migration runner had no exclusive lock (two pods racing a rollout can both pass the
// "not yet applied" check for the SAME file before either commits) and no checksum (an already-applied
// migration's content can drift from what is on disk with nothing noticing). Both pins RUN the shipped
// `src/migrate.ts` — reading the source would miss a fix that computes the right thing and never uses
// it (the exact #849 lesson the neighbouring 804 test file states).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { describe, it, expect } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const serverDir = join(repoRoot, 'apps/server')
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

function runMigrate(dir: string, adminUrl: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [tsxCli, 'src/migrate.ts'], {
    cwd: serverDir,
    env: { ...process.env, MIGRATIONS_DIR: dir, DATABASE_ADMIN_URL: adminUrl },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('#988 the migration runner', () => {
  it('refuses (exit non-zero) when an already-applied file\'s content changed on disk', async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
    expect(adminUrl, 'the server test env carries a database — this pin needs it').toBeTruthy()
    const dir = mkdtempSync(join(tmpdir(), 'wks-988-checksum-'))
    const marker = `zzz_probe_988_checksum_${process.pid}_${Date.now()}.sql`
    writeFileSync(join(dir, marker), 'SELECT 1;\n')
    const sql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    try {
      const first = runMigrate(dir, adminUrl!)
      expect(first.status, `first run should apply cleanly:\n${first.stderr}`).toBe(0)
      const [row] = await sql<{ checksum: string | null }[]>`SELECT checksum FROM schema_migrations WHERE filename = ${marker}`
      expect(row?.checksum, 'the applied row has no checksum recorded').toBe(
        createHash('sha256').update('SELECT 1;\n').digest('hex'),
      )

      // Tamper: the file on disk now says something the recorded checksum does not agree with.
      writeFileSync(join(dir, marker), 'SELECT 2;\n')
      const second = runMigrate(dir, adminUrl!)
      expect(second.status, 'a tampered already-applied migration must refuse, not exit clean').not.toBe(0)
      expect(second.stderr, 'the refusal does not name the checksum mismatch').toMatch(/CHECKSUM MISMATCH/)
    } finally {
      await sql`DELETE FROM schema_migrations WHERE filename = ${marker}`.catch(() => {})
      await sql.end()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('backfills a NULL checksum (a row from before this column existed) without re-running the DDL', async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
    expect(adminUrl).toBeTruthy()
    const dir = mkdtempSync(join(tmpdir(), 'wks-988-backfill-'))
    const marker = `zzz_probe_988_backfill_${process.pid}_${Date.now()}.sql`
    const tableName = `zzz_probe_988_table_${process.pid}`
    // DDL that is NOT idempotent — CREATE TABLE with no IF NOT EXISTS. If the runner treats this
    // pre-existing (checksum-less) row as "not yet applied" and re-runs it, the second CREATE TABLE
    // throws and the whole run fails loudly — which is exactly what proves the backfill path did NOT
    // re-execute anything.
    writeFileSync(join(dir, marker), `CREATE TABLE ${tableName} (id int);\n`)
    const sql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    try {
      // Simulate a pre-#988 deployment: the row exists (as if applied long ago), checksum column is
      // NULL because it did not exist yet. `checksum` already exists on the shared schema (this suite
      // shares one DB across files), so this simulates a row rather than the column's own arrival.
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
      await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`
      await sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${marker}, NULL)`
      await sql`CREATE TABLE ${sql(tableName)} (id int)` // the table the migration WOULD create — pre-created, matching "already applied"

      const result = runMigrate(dir, adminUrl!)
      expect(result.status, `backfill run should succeed, not re-run the DDL:\n${result.stderr}`).toBe(0)
      expect(result.stdout, 'did not take the backfill path').toMatch(/checksum recorded/)
      const [row] = await sql<{ checksum: string | null }[]>`SELECT checksum FROM schema_migrations WHERE filename = ${marker}`
      expect(row?.checksum).toBe(createHash('sha256').update(`CREATE TABLE ${tableName} (id int);\n`).digest('hex'))
    } finally {
      await sql`DELETE FROM schema_migrations WHERE filename = ${marker}`.catch(() => {})
      await sql`DROP TABLE IF EXISTS ${sql(tableName)}`.catch(() => {})
      await sql.end()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('two runners started at the same time do not double-apply or crash — the lock serializes them', async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
    expect(adminUrl).toBeTruthy()
    const dir = mkdtempSync(join(tmpdir(), 'wks-988-race-'))
    const marker = `zzz_probe_988_race_${process.pid}_${Date.now()}.sql`
    writeFileSync(join(dir, marker), 'SELECT 1;\n')
    const sql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    const spawnOne = () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, 'src/migrate.ts'], {
        cwd: serverDir,
        env: { ...process.env, MIGRATIONS_DIR: dir, DATABASE_ADMIN_URL: adminUrl! },
        stdio: 'pipe',
      })
      child.on('exit', (code) => resolve(code))
    })
    try {
      const [a, b] = await Promise.all([spawnOne(), spawnOne()])
      expect([a, b], 'a concurrent runner crashed instead of waiting for the lock').toEqual([0, 0])
      const rows = await sql`SELECT filename FROM schema_migrations WHERE filename = ${marker}`
      expect(rows.length, 'the migration was applied more than once (or not at all)').toBe(1)
    } finally {
      await sql`DELETE FROM schema_migrations WHERE filename = ${marker}`.catch(() => {})
      await sql.end()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
