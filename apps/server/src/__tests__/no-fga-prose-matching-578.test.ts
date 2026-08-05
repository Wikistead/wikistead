// #578 → #622 review: nobody may branch on the permission store's own sentence.
//
// #578 replaced FGA's validation prose at the tuple-helper boundary so an admin never reads it. That made
// every `String(err).includes('did not exist')` in the tree DEAD CODE — not a compile error, not a test
// failure, just a branch that can no longer be taken. Four sites were converted with #578; three survived
// (`syncPageParentTuple`, `trashPage`, `restorePage`) and quietly stopped converging: a move whose parent
// tuple was already gone answered 500, and a trash or restore retried after a partial failure could never
// finish. The comment in tuples.ts asserting nobody matched the text was simply wrong.
//
// The lesson is about the SHAPE, so the pin is a sweep rather than three names: any new catch that reads
// the store's words is dead on arrival, and this says so before it ships.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue
    const p = resolve(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

// The phrases FGA uses. What is banned is READING one to decide control flow — a `.includes(...)` /
// `.match(...)` / `.test(...)` against an error. Throwing our OWN message that happens to contain the same
// English ("a role with this name already exists") is not that, and the first cut of this sweep flagged
// four of those: a pin that cries about the wrong thing gets loosened by the next person.
const PROSE = /(did not exist|does not exist|already exist(s|ed)?)/
const READS_AN_ERROR = /\.(includes|match|test|indexOf|startsWith|endsWith)\s*\(/

describe('#578: nothing branches on the permission store\'s prose', () => {
  const files = walk(SRC)

  it('the sweep sees the tree (a broken walk must not pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(files.some((f) => f.endsWith('routes/pages.ts'))).toBe(true)
  })

  it('no source matches an FGA sentence to decide control flow', () => {
    const offenders: string[] = []
    for (const f of files) {
      // read as text regardless of stray NUL bytes — some route files carry them and tools that sniff for
      // binary truncate silently, which is how a sweep passes while missing half a file (#622 review)
      const lines = readFileSync(f, 'latin1').split('\n')
      for (const [i, raw] of lines.entries()) {
        const line = raw.trim()
        if (line.startsWith('//') || line.startsWith('*')) continue // a comment may quote the sentence
        if (!PROSE.test(line) || !READS_AN_ERROR.test(line)) continue
        // the one legitimate reader is the boundary helper itself, which lives in @wikistead/authz
        offenders.push(`${f.slice(SRC.length + 1)}:${i + 1} ${line.slice(0, 110)}`)
      }
    }
    expect(offenders, 'these are unreachable since #578 — use isAlreadyConverged(err)').toEqual([])
  })
})
