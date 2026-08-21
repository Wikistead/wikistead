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
import { migrationsDirCandidates, pickMigrationsDir, chooseMigrationsDir } from '../migrations-dir.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const dockerfile = join(repoRoot, 'apps/server/Dockerfile')

// #849: the lines a `docker build` actually ships. Everything before the LAST `FROM … AS <name>`
// belongs to a stage whose filesystem is thrown away, so a COPY there puts nothing in the image. The
// last stage is found by position and not by the name `runtime` — a rename would otherwise turn this
// check green while meaning nothing.
function runtimeStageLines(text: string): string[] {
  const lines = text.split('\n')
  let last = -1
  lines.forEach((l, i) => { if (/^\s*FROM\s/i.test(l)) last = i })
  expect(last, 'no FROM line — this is not a Dockerfile').toBeGreaterThanOrEqual(0)
  return lines.slice(last + 1)
}

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
    // #849: only the LAST stage counts. The first version of this filtered every COPY in the file, so
    // moving this line into the build stage — where the SQL is discarded with that stage's filesystem
    // — left all five assertions green. Measured before the fix: it did.
    const copies = runtimeStageLines(text)
      .filter((l) => /^\s*COPY\s/.test(l) && !/--from=/.test(l))
      .map((l) => l.trim())
    expect(copies.length, 'the last stage has no plain COPY lines — did the Dockerfile change shape?').toBeGreaterThan(0)
    const carriesSql = copies.some((l) => l.includes('infra/db/migrations') && l.includes(target))
    expect(carriesSql, `no COPY in the shipped stage puts infra/db/migrations at ${target}:\n${copies.join('\n')}`).toBe(true)
  })

  // #849: the two halves this file names are "the runner looks" and "the image carries" — and the
  // first was measured on the extracted RESOLVER, never on the executable that ships. Reverting
  // `migrate.ts` alone to its old hard-coded path left all five green while the image broke again.
  // The same class as #637: a pin has to reach the shipped code.
  //
  // Read rather than imported, because importing this module RUNS the migrations.
  it('the runner that ships is the one that was fixed', () => {
    const src = readFileSync(join(repoRoot, 'apps/server/src/migrate.ts'), 'utf8')
    // The rule is "the runner asks this module", not "the runner calls these two names" — #838
    // changed the entry point to `chooseMigrationsDir` and this assertion went red for a change that
    // kept the rule. It reads the import and one call into it.
    expect(src, 'migrate.ts does not import the resolver — the fix lives in a module nothing runs')
      .toMatch(/from '\.\/migrations-dir\.js'/)
    expect(src, 'migrate.ts imports the resolver but does not ask it anything')
      .toMatch(/\b(chooseMigrationsDir|pickMigrationsDir)\(/)
    // Importing the resolver and then building a path anyway is the version an import check misses.
    const ownPath = src.match(/^(?!.*\/\/).*(join|resolve)\([^)]*(infra\/db\/migrations|['"`]migrations['"`])/m)
    expect(ownPath?.[0] ?? null, 'migrate.ts composes a migrations path of its own beside the resolver').toBeNull()
  })

  // #838: `MIGRATIONS_DIR` is how an operator overrules the search. A name that is not there used to
  // fall through to the next layout — on the image, the SQL baked in at build time — so the run
  // migrated from something other than what was asked for, and said nothing. Measured on the built
  // image during #804's review.
  it('a named directory that is not there refuses instead of falling back', () => {
    const present = new Set(['/app/migrations', '/repo/infra/db/migrations'])
    const choice = chooseMigrationsDir('/app/dist/', { MIGRATIONS_DIR: '/nonexistent' }, (p) => present.has(p))
    expect(choice).toEqual({ kind: 'named-missing', named: '/nonexistent' })
  })

  it('…and a named directory that IS there still wins, as it always did', () => {
    // The other direction, and the one a refusal written too widely would break: naming a directory
    // has to keep working, or the refusal has taken the feature away instead of fixing it.
    const choice = chooseMigrationsDir('/app/dist/', { MIGRATIONS_DIR: '/mnt/sql' }, (p) => p === '/mnt/sql' || p === '/app/migrations')
    expect(choice).toEqual({ kind: 'found', dir: '/mnt/sql' })
    // And with no name at all the search order is untouched: deploy tree first, checkout second.
    expect(chooseMigrationsDir('/app/dist/', {}, (p) => p === '/app/migrations')).toEqual({ kind: 'found', dir: '/app/migrations' })
    expect(chooseMigrationsDir('/repo/apps/server/dist/', {}, (p) => p === '/repo/infra/db/migrations'))
      .toEqual({ kind: 'found', dir: '/repo/infra/db/migrations' })
    // Nothing anywhere is still its own answer, carrying what was looked at.
    const none = chooseMigrationsDir('/app/dist/', {}, () => false)
    expect(none.kind).toBe('none')
    expect(none.kind === 'none' && none.candidates.length, 'the refusal has to say where it looked').toBeGreaterThan(1)
  })

  it('the runner refuses a named directory rather than reporting one it did not use', () => {
    // Read, not imported: importing migrate.ts runs the migrations. What is asserted is that the
    // named-missing branch reaches `process.exit` rather than being logged and walked past.
    const src = readFileSync(join(repoRoot, 'apps/server/src/migrate.ts'), 'utf8')
    const branch = src.match(/named-missing[\s\S]{0,600}?\n\}/)?.[0] ?? ''
    expect(branch, 'migrate.ts does not handle the named-missing answer at all').not.toBe('')
    expect(branch, 'the named-missing branch does not stop the run').toMatch(/process\.exit\(1\)/)
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
