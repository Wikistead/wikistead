// Migration runner. Connects as the admin role (DATABASE_ADMIN_URL) to execute
// DDL. Never run as the restricted app role — CREATE TABLE requires privileges
// the runtime role intentionally does not have.
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { chooseMigrationsDir } from './migrations-dir.js'

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
if (!url) { console.error('DATABASE_ADMIN_URL or DATABASE_URL required'); process.exit(1) }

// #621: the same split-brain the seed can fall into — migrating another session's stack is worse.
//
// #621 re-review: the first version STATICALLY imported the guard from the repo's `scripts/`, and this
// runner ships. apps/server/Dockerfile's COPY list is deliberately narrow (CE-only, see its header), so
// `scripts/` is not in the image and the build broke on TS2307 — a dev-only helper made a build
// dependency of the product. The offset is a development concept and the env var is never set in a
// deployed image, so the guard is loaded ONLY when someone asked for isolation, through a specifier tsc
// does not resolve: the image neither compiles against the file nor needs it at runtime.
if (process.env.WKS_STACK_OFFSET) {
  const href = new URL('../../../scripts/assert-stack-target.mjs', import.meta.url).href
  const mod = await import(/* @vite-ignore */ href) as { assertStackTarget(url: string, what: string): void }
  mod.assertStackTarget(url, 'migrate')
}

const sql = postgres(url, { max: 1, onnotice: () => {} })

// #804: the image is a deploy tree, not a checkout — see migrations-dir.ts for the three layouts.
const moduleDir = fileURLToPath(new URL('.', import.meta.url))
const choice = chooseMigrationsDir(moduleDir, process.env, existsSync)
if (choice.kind === 'named-missing') {
  // #838: told where to look and it is not there. Falling back would run the image's own SQL under
  // the operator's instruction to run something else, and say nothing.
  console.error(`MIGRATIONS_DIR is set to ${choice.named}, and there is no directory there.`)
  console.error('Refusing to fall back: unset it to search the default layouts, or fix the path.')
  process.exit(1)
}
if (choice.kind === 'none') {
  console.error('no migrations directory found. Looked in:\n  ' + choice.candidates.join('\n  '))
  console.error('Set MIGRATIONS_DIR if the SQL lives somewhere else.')
  process.exit(1)
}
const migrationsDir = choice.dir

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

// #435 backfill note (#688): the Access Transparency backfill moved with the feature into
// @wikistead-ee/server — auditEeMount runs it at boot on the admin connection (idempotent, multiset
// match, serialized by OPERATOR_CHAIN_LOCK, and a failure still fails LOUDLY — it aborts the EE
// boot). A CE build has no transparency log to project into, so this script has nothing to do.

await sql.end()
console.log('migrations complete')
