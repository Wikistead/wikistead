// #623: a keyset cursor on a timestamp column travels as an epoch NUMERIC, everywhere.
//
// The bug was found on `/spaces`, flagged as "`/members` is the same shape", and left. `/members` was
// still wrong a day later, and so were three more: the public listing, the webhook list, and three
// queries behind the notification feeds. Four routes, one mistake, found one at a time.
//
// The mistake: `created_at` is a `timestamptz(6)` and Postgres keeps microseconds. A cursor carried as
// an ISO string — or read back into a JS `Date`, which is the same loss by another route — stops at
// milliseconds, so it names an EARLIER instant than the row it came from. Which way that hurts depends
// on the sort:
//
//   ASC  (`>`)  the boundary row is greater than its own cursor, so it comes round again — and on
//               `/members` the cursor stopped advancing entirely: the same three of nine, forever.
//   DESC (`<`)  the rows between the truncated instant and the true one are on the wrong side, so they
//               appear on NO page. A published page missing from the public listing, or a notification
//               nobody is told about, is invisible rather than noisy.
//
// So this is a rule rather than four fixes: any keyset comparison against a timestamp column must go
// through `to_timestamp(…::numeric)`. A number is a number to the driver and nothing rounds it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(full)
    return e.name.endsWith('.ts') ? [full] : []
  })

/**
 * Keyset comparisons: a row constructor compared against another with `<` or `>`.
 *
 * Matched on the SHAPE rather than on a list of routes — a fifth paged list added next month is found
 * by the thing that makes it a keyset walk.
 */
const KEYSET = /\(\s*[\w.]*created_at\s*,[^)]*\)\s*[<>]\s*\(([^)]*)\)/g

/** …and the only spelling allowed to carry the instant. */
const SAFE = /to_timestamp\s*\(/

const sources = walk(ROOT)

describe('#623: every keyset cursor keeps its microseconds', () => {
  it('finds the keyset comparisons it is meant to check', () => {
    // Without this the case below passes over an empty list: a rewrite into a query builder, a renamed
    // column, and the rule goes quietly green while the bug walks back in.
    const n = sources.reduce((acc, f) => acc + [...readFileSync(f, 'utf8').matchAll(KEYSET)].length, 0)
    expect(n, 'no keyset comparisons were found at all — has the shape changed?').toBeGreaterThanOrEqual(4)
  })

  it('none of them compares against a timestamp the driver has rounded', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(KEYSET)) {
        if (SAFE.test(m[1]!)) continue
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${file.slice(ROOT.length + 1)}:${line} — ${m[0]!.replace(/\s+/g, ' ').slice(0, 90)}`)
      }
    }
    expect(offenders, `these cursors lose microseconds:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('and nothing builds a cursor out of an ISO string', () => {
    // The other end of the same mistake. A route could compare correctly and still hand back a value
    // that has already lost the precision — `to_timestamp` cannot restore what the string never held.
    const offenders: string[] = []
    for (const file of sources) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/nextCursor[^\n]*toISOString\(\)|Cursor[^\n]*=[^\n]*toISOString\(\)/g)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${file.slice(ROOT.length + 1)}:${line}`)
      }
    }
    expect(offenders, `these mint a cursor at millisecond precision:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})
