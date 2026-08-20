// #804: an operator holding the image must be able to create the database.
//
// The runner used to resolve one path, the repository's, and the image is not a repository — it is a
// deploy tree with the package under /app and nothing above it. The gap was found the hard way: the
// first real Kubernetes deployment loaded 130 SQL files into a ConfigMap because the image could not
// be asked to migrate (#802's field notes).
//
// Two halves, and BOTH have to hold or the fix is half a fix: the runner has to look where the image
// puts the SQL, and the image has to put it there. A pin on only the first passes over an image with
// no SQL in it; a pin on only the second passes over a runner that never looks.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { migrationsDirCandidates, pickMigrationsDir } from '../migrations-dir.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const dockerfile = join(repoRoot, 'apps/server/Dockerfile')

describe('#804 the schema ships with the image that needs it', () => {
  it('the runner finds the SQL in a deploy tree, where the image puts it', () => {
    // The image: runner at /app/dist/migrate.js, SQL at /app/migrations. The repository entry is
    // three levels above /app and resolves outside the image, so it must NOT be what answers here.
    const present = new Set(['/app/migrations'])
    const chosen = pickMigrationsDir(migrationsDirCandidates('/app/dist/', {}), (p) => present.has(p))
    expect(chosen).toBe('/app/migrations')
  })

  it('the runner still finds the SQL in a checkout, compiled or not', () => {
    for (const moduleDir of ['/repo/apps/server/src/', '/repo/apps/server/dist/']) {
      const present = new Set(['/repo/infra/db/migrations'])
      const chosen = pickMigrationsDir(migrationsDirCandidates(moduleDir, {}), (p) => present.has(p))
      expect(chosen, moduleDir).toBe('/repo/infra/db/migrations')
    }
  })

  it('a named directory wins over both, and nothing found answers null', () => {
    const named = migrationsDirCandidates('/app/dist/', { MIGRATIONS_DIR: '/mnt/sql' })
    expect(pickMigrationsDir(named, (p) => p === '/mnt/sql' || p === '/app/migrations')).toBe('/mnt/sql')
    // Nothing found is null, never a guess: migrating from a directory that is not there would
    // report success over a database it never touched.
    expect(pickMigrationsDir(migrationsDirCandidates('/app/dist/', {}), () => false)).toBeNull()
  })

  it('the image copies the migrations to the place the runner looks second', () => {
    const text = readFileSync(dockerfile, 'utf8')
    // Read from the file rather than restated here: the runner's own second candidate is the
    // subject, so the two cannot drift into agreeing about different paths.
    const target = migrationsDirCandidates('/app/dist/', {})[0]! // /app/migrations
    const copies = text
      .split('\n')
      .filter((l) => /^\s*COPY\s/.test(l) && !/--from=/.test(l))
      .map((l) => l.trim())
    expect(copies.length, 'no plain COPY lines — did the Dockerfile change shape?').toBeGreaterThan(0)
    const carriesSql = copies.some((l) => l.includes('infra/db/migrations') && l.includes(target))
    expect(carriesSql, `no COPY puts infra/db/migrations at ${target}:\n${copies.join('\n')}`).toBe(true)
  })

  it('there is SQL to carry (the check is not measuring an empty directory)', () => {
    const dir = join(repoRoot, 'infra/db/migrations')
    expect(existsSync(dir)).toBe(true)
    const sql = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    // A floor, not the exact count: the number grows, and an empty or near-empty read would make
    // every assertion above vacuous.
    expect(sql.length, 'migrations directory is empty or missing').toBeGreaterThan(100)
  })
})
