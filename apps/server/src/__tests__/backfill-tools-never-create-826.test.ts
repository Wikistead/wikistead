// ADR-253 §3.7a/§8②: only a boot resolves (and, on the very first one, creates); everything else
// reads or refuses.
//
// viewer-member-backfill.ts, private-sharelink-backfill.ts and orphan-claim-sweep.ts import
// `fgaClient` without going through server.ts's boot. Under the lazy client (§3.7) that is already
// safe BY CONSTRUCTION: `fgaClient` only ever falls back to plain environment-constructed access
// unless something calls `supplyResolvedFga` first, and nothing outside `server.ts`'s boot does — so
// a backfill run cannot create a store no matter what its own environment happens to name.
//
// One named exception: `forget-openfga-store-binding.ts` (§8②) reads and deletes the witness row —
// never a store — which is the one operation this file's own ban must not catch, since it is exactly
// what that command exists to do. The exception is verified below, not just declared: it must
// actually import `openfga-resolve.js`, and it must import ONLY the read/delete functions, never the
// creating entry point or either write function (`ADR-253 an exemption must name someone who
// actually has it`).
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SCRIPTS_DIR = resolve(import.meta.dirname, '../scripts')
const CAN_READ_THE_WITNESS = ['forget-openfga-store-binding.ts']

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

  it('no script in this directory (other than the named §8② exception) imports openfga-resolve.js', () => {
    const offenders = scriptFiles().filter((f) => {
      if (CAN_READ_THE_WITNESS.includes(f)) return false
      const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8')
      return /resolveStoreBindingLocked|openfga-resolve\.js/.test(src)
    })
    expect(offenders, `these scripts can create a store outside boot: ${offenders.join(', ')}`).toEqual([])
  })

  it('the named §8② exception imports only the read/forget functions, never creation or a write', () => {
    // The actual IMPORT STATEMENT only — a source-text scan would also catch this very file's own
    // prose explaining which functions it does NOT use (see the header above), which is exactly
    // backwards for a check whose point is what gets called.
    for (const name of CAN_READ_THE_WITNESS) {
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8')
      const importLine = src.match(/^import \{([^}]+)\} from ['"]\.\.\/openfga-resolve\.js['"]/m)
      expect(importLine, `${name} does not import openfga-resolve.js — the exemption is stale, remove it`).not.toBeNull()
      const imported = importLine![1].split(',').map((s) => s.trim())
      for (const name2 of ['resolveStoreBindingLocked', 'resolveStoreBinding', 'writeWitness', 'rebindWitness']) {
        expect(imported, `${name} imports ${name2} — that is exactly what §8② must not do`).not.toContain(name2)
      }
    }
  })
})
