// Migration runner. Connects as the admin role (DATABASE_ADMIN_URL) to execute
// DDL. Never run as the restricted app role — CREATE TABLE requires privileges
// the runtime role intentionally does not have.
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { chooseMigrationsDir } from './migrations-dir.js'

// #988: an exclusive advisory lock for the whole run. A rolling deploy can start this script from more
// than one pod at once; without a lock, two runners can both pass the "not yet applied" check for the
// SAME file before either commits, then race the CREATE TABLE / INSERT — one throws a primary-key or
// duplicate-object error instead of skipping cleanly. Session-scoped (held on this script's single
// connection, `max: 1` below) and released when the process exits, so a crashed runner never leaves
// the lock held forever. A fixed, arbitrary key — advisory locks are keyed by a bigint, not a name.
const MIGRATE_LOCK_KEY = 988_001

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

// #988: acquired BEFORE the table even exists — a second runner racing this one for `CREATE TABLE IF
// NOT EXISTS` itself is exactly the failure mode a lock taken only around the loop would still allow.
// Blocking (not `pg_try_advisory_lock`): a second pod SHOULD wait for the first to finish, not fail
// its rollout over a lock a moment earlier would have cleared.
await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`
try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  // #988: additive — a deployment that already has this table (every one, pre-this-ticket) gets the
  // column with no backfill migration of its own. NULL for every already-applied row until the loop
  // below backfills it (once, the first time each row is seen by the new runner).
  await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const content = await readFile(join(migrationsDir, file), 'utf8')
    const checksum = createHash('sha256').update(content).digest('hex')
    const [existing] = await sql<{ checksum: string | null }[]>`SELECT checksum FROM schema_migrations WHERE filename = ${file}`

    if (existing) {
      if (existing.checksum === null) {
        // #988: no historical checksum to compare against (this row predates the column) — trust and
        // record what is on disk NOW, once. Anything that changes AFTER this point is caught below.
        await sql`UPDATE schema_migrations SET checksum = ${checksum} WHERE filename = ${file}`
        console.log(`skip  ${file} (checksum recorded)`)
      } else if (existing.checksum !== checksum) {
        // #988: an already-applied migration's CONTENT changed on disk. The schema this ran against
        // and the SQL sitting in the repo now have silently diverged — never re-run it (the DDL already
        // executed and re-running is not idempotent in general), and never skip it quietly either.
        console.error(`CHECKSUM MISMATCH: ${file} was applied with different content than is on disk now.`)
        console.error(`  recorded (applied): ${existing.checksum}`)
        console.error(`  on disk (now):      ${checksum}`)
        console.error('An already-applied migration must never change — add a NEW migration file instead.')
        process.exit(1)
      } else {
        console.log(`skip  ${file}`)
      }
      continue
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(content)
      await tx`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})`
    })
    console.log(`apply ${file}`)
  }

  // #435 backfill note (#688): the Access Transparency backfill moved with the feature into
  // @wikistead-ee/server — auditEeMount runs it at boot on the admin connection (idempotent, multiset
  // match, serialized by OPERATOR_CHAIN_LOCK, and a failure still fails LOUDLY — it aborts the EE
  // boot). A CE build has no transparency log to project into, so this script has nothing to do.
} finally {
  // #988: released even on a thrown error (a bad migration's exception must not leave the NEXT
  // deploy's runner waiting on a lock nothing will ever release short of the connection dying).
  await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`.catch(() => {})
}

await sql.end()
console.log('migrations complete')
