// #648: the analytics "sort" control did nothing at all.
//
// The server honoured it — `rollup.ts` swapped its ORDER BY between four static fragments — and the
// chart then threw that order away and sorted by day itself. Both halves were doing what they were
// written to do; nobody had checked they were doing it to each other. Every request carried the
// parameter and every SVG came back identical.
//
// Underneath is a shape thing rather than a bug: this surface draws ONE time-series chart and no table
// of rows. A sort order is an answer to "which row comes first", and there are no rows — which is why
// the chart re-sorts by day and why the user's reading ("sorting would make sense for user names")
// was the accurate one.
//
// The pins below are scans rather than a list of files. A control that is gone from the two surfaces
// but still built by a third would satisfy an enumeration and reappear on screen.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WEB = resolve(import.meta.dirname, '..')
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name)) : /\.tsx?$/.test(e.name) ? [resolve(dir, e.name)] : [])

/** Source with comments stripped: prose may name the parameter it exists to explain. */
const codeOf = (f: string): string =>
  readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '')).join('\n')

const sources = walk(WEB).filter((f) => !/\.test\.tsx?$/.test(f))

describe('#648: nothing offers an ordering the analytics surface cannot honour', () => {
  // #892: the two cases below assert that a scan found NOTHING, which is also what a scan that ran
  // over nothing reports. Measured on 2026-08-22: pointing `WEB` at an empty directory left this file
  // 2/2 green. A pin whose walk has stopped walking is worse than no pin — it reads as coverage.
  it('scanned the web source at all', () => {
    expect(sources.length, `no sources found under ${WEB}`).toBeGreaterThanOrEqual(100)
    expect(sources.some((f) => f.endsWith('AnalyticsDashboard.tsx')), 'the analytics surface itself was not scanned').toBe(true)
  })

  it('no surface builds a sort control for the roll-up', () => {
    // Keyed on the testId suffix rather than on a filename: the dashboard is shared, so a second
    // surface adding its own control would be a new file this scan still catches.
    const offenders = sources.filter((f) => /-sort`|"analytics-sort"|'analytics-sort'/.test(codeOf(f)))
    expect(offenders.map((f) => f.slice(WEB.length + 1)), 'a sort control is back').toEqual([])
  })

  it('no client code sends sort or dir to the analytics endpoints', () => {
    // The request half. Removing the control while still sending a default would leave the server
    // branch alive and reachable by anyone typing the query string.
    const offenders = sources.filter((f) => {
      const src = codeOf(f)
      return /spaceAnalyticsQuery|space-analytics|admin\/analytics/.test(src) && /\bqs\.set\("(sort|dir)"|\bsort:\s*"|\bdir:\s*"/.test(src)
    })
    expect(offenders.map((f) => f.slice(WEB.length + 1)), 'sort/dir still leaves the client').toEqual([])
  })

  // The orphan locale keys are NOT pinned here. `i18n/no-orphan-keys-645.test.ts` already asks the
  // whole product "does every key have a reader", which is the same question asked once instead of
  // once per feature — and a copy of it scoped to this namespace would pass while the general one
  // failed, which is worse than not having it. Deleting the control without deleting the five ordering
  // keys turns that scanner red; measured, not assumed.
  //
  // Writing the key names out here would have defeated it: that scanner counts any occurrence in the
  // tree as a reader, so prose naming its own subject makes an orphan look read. It found four of the
  // five until this comment stopped spelling the prefix.
})
