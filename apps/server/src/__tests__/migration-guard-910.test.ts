// #910: a server whose image ships migrations the database lacks refuses to start, by name.
//
// The defect: a rollout replaced the image and nothing else; the server booted, and the first
// request that touched the new column failed with 42703 behind "could not publish". Boot compared
// nothing. The pin below asks the real ledger of the real test database (migrated by setup) and
// the real shipped tree, then plants one extra shipped file to show the verdict moves.
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { pool } from '../db/pool.js'
import { appliedFromDb, judgeMigrations, pendingMigrations, shippedFromTree } from '../db/migration-guard.js'

describe('#910 the migration guard', () => {
  it('pure: pending is the shipped SQL the ledger lacks, in apply order', () => {
    expect(pendingMigrations(['002_b.sql', '001_a.sql', 'README.md'], new Set(['001_a.sql']))).toEqual(['002_b.sql'])
    expect(pendingMigrations(['001_a.sql'], new Set(['001_a.sql']))).toEqual([])
  })

  it('a migrated database and the shipped tree agree: fresh', async () => {
    const tree = shippedFromTree(fileURLToPath(new URL('..', import.meta.url)), process.env)
    expect(tree.kind).toBe('found')
    if (tree.kind !== 'found') return
    const shipped = await tree.list()
    expect(shipped.length, 'the resolver found a directory with no SQL in it').toBeGreaterThan(100)
    const verdict = await judgeMigrations({ shipped: tree.list, applied: () => appliedFromDb(pool) })
    expect(verdict).toEqual({ kind: 'fresh' })

    // One file the image ships that the ledger never saw — the rollout shape — and the verdict
    // names it. Break-check: make judgeMigrations return 'fresh' unconditionally and this is red.
    const planted = await judgeMigrations({
      shipped: async () => [...shipped, '999_not_yet_applied.sql'],
      applied: () => appliedFromDb(pool),
    })
    expect(planted).toEqual({ kind: 'pending', files: ['999_not_yet_applied.sql'] })
  })

  it('a database with no ledger is a database nobody migrated', async () => {
    const verdict = await judgeMigrations({ shipped: async () => ['001_a.sql'], applied: async () => null })
    expect(verdict).toEqual({ kind: 'no-ledger' })
    // The reader maps the missing table (42P01) to null, not to a throw and not to "nothing applied".
    const missing = await appliedFromDb(pool)
    expect(missing).not.toBeNull() // the test database is migrated; the null path is the branch above
  })
})
