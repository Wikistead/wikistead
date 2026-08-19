// #773: the server suite's hooks died with "Hook timed out in 60000ms" on a file whose every assertion
// passed. The segment that waited was `pool.end()`, and the differential that named the cause was the
// acquire/release count at that moment: the hung runs ended the pool with 7 reserved / 6 returned, the
// green ones with 7 / 7. A tenant handle returns through a QUERY, and a query issued after `end()` has
// begun never runs — so the release waits for the pool and the pool waits for the release, forever.
//
// These pin the two halves of the fix: `end()` waits for the handles that are on their way back, and a
// handle that never comes back ends the shutdown anyway INSTEAD OF hiding — a never-released handle is
// a different bug (a connection lost out of max: 20) and must not look like a clean shutdown.
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool, reserveTracked, reservedCount, waitForReserved } from '../db/pool.js'

const SRC = resolve(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('#773 the pool does not end underneath a returning handle', () => {
  it('waits while a handle is still on its way back, then reports nothing outstanding', async () => {
    let busy = 2
    setTimeout(() => (busy = 1), 40)
    setTimeout(() => (busy = 0), 90)
    const t0 = Date.now()
    expect(await waitForReserved(() => busy, 5_000, 10)).toBe(0)
    // It really waited — returning 0 immediately would mean it never looked.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80)
  })

  it('gives up at the bound and hands back what never returned', async () => {
    const t0 = Date.now()
    expect(await waitForReserved(() => 3, 120, 10)).toBe(3)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
    expect(Date.now() - t0).toBeLessThan(3_000) // bounded — the whole point is that it stops waiting
  })

  it('counts a reserved handle out and back, and a double release does not under-count', async () => {
    const before = reservedCount()
    const handle = await reserveTracked()
    expect(reservedCount()).toBe(before + 1)
    handle.release()
    expect(reservedCount()).toBe(before)
    handle.release() // a second release must not push the count below the handles still out
    expect(reservedCount()).toBe(before)
  })

  // Discovery, not a list: a third acquire site written later escapes a per-caller counter silently,
  // and the failure it causes (an unbounded hang at shutdown) carries no clue back to the new call.
  it('leaves pool.reserve reachable from nowhere but the seam that counts it', () => {
    const files = walk(SRC).filter((f) => !f.includes(`${'__tests__'}`))
    expect(files.length).toBeGreaterThan(50) // the walk found the tree, not an empty directory
    const offenders = files.filter(
      (f) => f !== resolve(SRC, 'db/pool.ts') && /\.reserve\(\)/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })

  // Last: it ends the pool. This is the shape that hung — a handle released a beat after the caller
  // decided to shut down.
  it('survives a handle that is released just after the shutdown starts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await reserveTracked()
    setTimeout(() => handle.release(), 200)
    await pool.end()
    expect(reservedCount()).toBe(0)
    // Waited for it rather than tearing it out: a forced close would have been reported.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('never returned')
    warn.mockRestore()
  })
})
