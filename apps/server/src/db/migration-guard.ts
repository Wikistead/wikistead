// #910: a server whose image ships migrations the database has not received must not start.
//
// The image carries its SQL (#804) and the migrate job runs it — but only when somebody runs the
// job. A rollout that replaced the image and nothing else booted a server that assumed column
// 126 existed, and the first request that touched it failed with 42703, long after boot, behind a
// toast that could only say "could not publish". Nothing at boot compared what the code expects
// with what the database has. This does, before buildApp, and refuses by name.
//
// The comparison is by filename against schema_migrations — the same ledger migrate.ts writes —
// so a migration the image ships and the ledger lacks is pending, whatever its content. A ledger
// that does not exist at all is a database nobody has migrated, which is the same refusal with a
// shorter list.
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Sql } from 'postgres'
import { chooseMigrationsDir } from '../migrations-dir.js'

/** Pure: the shipped files the ledger has not recorded, in apply order. */
export function pendingMigrations(shipped: readonly string[], applied: ReadonlySet<string>): string[] {
  return shipped.filter((f) => f.endsWith('.sql') && !applied.has(f)).sort()
}

export type MigrationGuardVerdict =
  | { kind: 'fresh' }
  | { kind: 'pending'; files: string[] }
  | { kind: 'no-ledger' }
  | { kind: 'no-dir'; candidates: string[] }
  | { kind: 'named-missing'; named: string }

/** The decision, with the two reads handed in so a test can pick the database and the tree. */
export async function judgeMigrations(args: {
  shipped: () => Promise<readonly string[]>
  /** `null` when schema_migrations does not exist. */
  applied: () => Promise<ReadonlySet<string> | null>
}): Promise<MigrationGuardVerdict> {
  const applied = await args.applied()
  if (applied === null) return { kind: 'no-ledger' }
  const pending = pendingMigrations(await args.shipped(), applied)
  return pending.length ? { kind: 'pending', files: pending } : { kind: 'fresh' }
}

/** Reads the ledger through the app's own pool; `null` when the table is not there (42P01). */
export async function appliedFromDb(sql: Sql): Promise<ReadonlySet<string> | null> {
  try {
    const rows = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`
    return new Set(rows.map((r) => r.filename))
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return null
    throw e
  }
}

/** The files the running image ships, from the same resolver migrate.ts uses. */
export function shippedFromTree(moduleDir: string, env: Record<string, string | undefined>):
  | { kind: 'found'; list: () => Promise<readonly string[]> }
  | { kind: 'named-missing'; named: string }
  | { kind: 'no-dir'; candidates: string[] } {
  const choice = chooseMigrationsDir(moduleDir, env, existsSync)
  if (choice.kind === 'named-missing') return choice
  if (choice.kind === 'none') return { kind: 'no-dir', candidates: choice.candidates }
  const dir = choice.dir
  return { kind: 'found', list: async () => (await readdir(dir)).filter((f) => f.endsWith('.sql')) }
}

/** Boot-time: refuse (exit 1, naming the files) unless every shipped migration is in the ledger. */
export async function assertMigrationsApplied(sql: Sql): Promise<void> {
  if (process.env.WIKISTEAD_SKIP_MIGRATION_GUARD === '1') return
  // The resolver is written for migrate.ts's directory (src/ or dist/); this file sits one below it.
  const moduleDir = fileURLToPath(new URL('..', import.meta.url))
  const tree = shippedFromTree(moduleDir, process.env)
  if (tree.kind === 'named-missing') {
    console.error(`MIGRATIONS_DIR is set to ${tree.named}, and there is no directory there.`)
    process.exit(1)
  }
  if (tree.kind === 'no-dir') {
    // The image always carries its SQL (#804); a tree without it is a checkout shape this guard
    // cannot judge. Say so and let the migrate runner be the one that refuses.
    console.warn('migration guard: no migrations directory found; skipping. Looked in:\n  ' + tree.candidates.join('\n  '))
    return
  }
  const verdict = await judgeMigrations({ shipped: tree.list, applied: () => appliedFromDb(sql) })
  if (verdict.kind === 'fresh') return
  if (verdict.kind === 'no-ledger') {
    console.error('FATAL: this database has never been migrated (no schema_migrations table). Run the migrate job first.')
  } else if (verdict.kind === 'pending') {
    console.error(`FATAL: ${verdict.files.length} migration(s) this image ships are not applied to the database:\n  ${verdict.files.join('\n  ')}`)
    console.error('Run the migrate job (node dist/migrate.js) against this database, then start the server.')
  }
  console.error('Set WIKISTEAD_SKIP_MIGRATION_GUARD=1 to start anyway (you will get 42703 where the schema is missing).')
  process.exit(1)
}
