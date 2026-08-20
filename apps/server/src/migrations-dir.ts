// #804: where the migration files are, asked in a way that survives being deployed.
//
// The runner resolved one path — `../../../infra/db/migrations` from its own module — which is the
// repository's layout and only the repository's. The published image is a deploy tree: the package
// and its production dependencies under /app, and nothing above it. Three levels up from
// /app/dist lands outside the image, so an operator holding only the image could not migrate at
// all; the field report for the Helm chart had to load 130 SQL files into a ConfigMap to get a
// database up (#802). The image ships the SQL now, and this picks whichever layout it is standing
// in — repository checkout, deploy tree, or a path an operator names.
//
// Split out of migrate.ts because that file is a SCRIPT: importing it to test anything runs the
// migrations. This module holds no side effects, so the choice can be measured directly.
import { resolve } from 'node:path'

/** The places a migration directory can be, in the order they win. */
export function migrationsDirCandidates(moduleDir: string, env: Record<string, string | undefined>): string[] {
  // Resolved, not concatenated: these paths are printed when nothing is found, and `/app/dist/../
  // migrations` tells an operator less about where to put the SQL than `/app/migrations` does.
  const named = env.MIGRATIONS_DIR?.trim()
  return [
    // An operator naming the directory outright wins: a chart mounting the SQL, a one-off run
    // against a copy. Nothing else can express that.
    ...(named ? [named] : []),
    // The deploy tree: the image copies the SQL beside the package (/app/migrations, with the
    // runner at /app/dist/migrate.js).
    resolve(moduleDir, '..', 'migrations'),
    // The repository: apps/server/{src,dist} → repo root → infra/db/migrations. Both the tsx run
    // and the compiled run sit at the same depth, which is why one entry covers both.
    resolve(moduleDir, '..', '..', '..', 'infra', 'db', 'migrations'),
  ]
}

/**
 * The first candidate that exists. Returns null rather than guessing — a runner that silently
 * migrates from an empty directory reports success over a database it never touched.
 */
export function pickMigrationsDir(candidates: readonly string[], exists: (path: string) => boolean): string | null {
  for (const candidate of candidates) if (exists(candidate)) return candidate
  return null
}
