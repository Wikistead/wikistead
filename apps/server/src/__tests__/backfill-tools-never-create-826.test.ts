// ADR-253 §3.7a: only a boot resolves; everything else reads or refuses.
//
// viewer-member-backfill.ts, private-sharelink-backfill.ts and orphan-claim-sweep.ts import
// `fgaClient` without going through server.ts's boot. Under the lazy client (§3.7) that is already
// safe BY CONSTRUCTION: `fgaClient` only ever falls back to plain environment-constructed access
// unless something calls `supplyResolvedFga` first, and nothing outside `server.ts`'s boot does — so
// a backfill run cannot create a store no matter what its own environment happens to name. This pin
// keeps that true structurally: no script in this directory may import the creating entry point.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SCRIPTS_DIR = resolve(import.meta.dirname, '../scripts')

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.ts') && !/\.(test|spec)\./.test(f))
}

describe('ADR-253 §3.7a scripts read or refuse — never create', () => {
  it('the three named backfill/sweep tools exist and import fgaClient without a boot', () => {
    for (const name of ['viewer-member-backfill.ts', 'private-sharelink-backfill.ts', 'orphan-claim-sweep.ts']) {
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8')
      expect(src, `${name} does not import fgaClient`).toMatch(/\bfgaClient\b/)
      expect(src, `${name} imports the boot-only resolver — it must not`).not.toMatch(/resolveStoreBindingLocked|openfga-resolve\.js/)
    }
  })

  it('no script in this directory imports the store-creating entry point', () => {
    const offenders = scriptFiles().filter((f) => {
      const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8')
      return /resolveStoreBindingLocked|openfga-resolve\.js/.test(src)
    })
    expect(offenders, `these scripts can create a store outside boot: ${offenders.join(', ')}`).toEqual([])
  })
})
