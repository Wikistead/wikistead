// Migration runner. Connects as the admin role (DATABASE_ADMIN_URL) to execute
// DDL. Never run as the restricted app role — CREATE TABLE requires privileges
// the runtime role intentionally does not have.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
if (!url) { console.error('DATABASE_ADMIN_URL or DATABASE_URL required'); process.exit(1) }

const sql = postgres(url, { max: 1, onnotice: () => {} })

const migrationsDir = join(fileURLToPath(new URL('.', import.meta.url)), '../../../infra/db/migrations')

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith('.sql'))
  .sort()

for (const file of files) {
  const rows = await sql`SELECT 1 FROM schema_migrations WHERE filename = ${file}`
  if (rows.length > 0) { console.log(`skip  ${file}`); continue }

  const content = await readFile(join(migrationsDir, file), 'utf8')
  await sql.begin(async (tx) => {
    await tx.unsafe(content)
    await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`
  })
  console.log(`apply ${file}`)
}

// #435 / ADR-169 (owner ruling: disclose the past too): project pre-feature operator ledger rows
// into the per-tenant Access Transparency log. This runs HERE — the admin connection — because the
// operator console's operator_ro role deliberately has no privilege on tenant_transparency_log.
// Idempotent (multiset match) and serialized against live break-glass appends (OPERATOR_CHAIN_LOCK),
// so re-running deploys is safe. A failure fails the migration run: silently skipping it would
// leave the disclosure ruling unimplemented with no signal.
const { backfillTransparencyProjection } = await import('./audit/transparency.js')
const { projected } = await backfillTransparencyProjection(sql)
if (projected > 0) console.log(`access-transparency backfill: ${projected} row(s) projected`)

await sql.end()
console.log('migrations complete')
