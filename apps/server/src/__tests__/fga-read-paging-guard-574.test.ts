// #574: the DISCOVERY pin for OpenFGA's silent truncation. Read answers ONE page (default 50) and
// drops the rest without a word unless continuation_token is followed — four separate tickets have
// now been caused by that (#540, #545, #553, #574), because nothing in the call site's shape says
// "this is a page". An enumerated list of known-bad call sites cannot help: it passes the N+1th
// (the #544 lesson). So this scans the SOURCE for direct `.read(` calls on an FGA client and
// requires each one to be either
//   - paginated (a continuation loop within a few lines), or
//   - annotated `// fga-read-ok: <why one page is enough>` — a structural bound, in words, on the
//     line itself or the line above.
// A new unannotated call fails HERE, at the moment it is written, instead of in production on the
// tenant that first crosses fifty tuples.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../../..', import.meta.url).pathname // repo root
const SCAN = ['apps/server/src', 'apps/collab/src', 'packages']
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', 'coverage'])
const CALL = /(?:^|[^.\w])(?:fga|fgaClient|app\.fga|deps\.fga|client)\s*\.\s*read\s*\(/

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* sources(full)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) yield full
  }
}

describe('#574: every direct FGA read is paginated or says why one page is enough', () => {
  it('no unannotated single-page read exists in server, collab or the packages', () => {
    const offenders: string[] = []
    for (const dir of SCAN) {
      for (const file of sources(join(ROOT, dir))) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!CALL.test(line)) return
          // a paginating call carries its token nearby (the loop's read + the token it feeds back)
          const near = lines.slice(Math.max(0, i - 6), i + 8).join('\n')
          if (/continuationToken|continuation_token/.test(near)) return
          // …or the author states the structural bound
          const annotated = /fga-read-ok:/.test(line) || /fga-read-ok:/.test(lines[i - 1] ?? '')
          if (annotated) return
          offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`)
        })
      }
    }
    expect(offenders, [
      'An FGA read here returns ONE page (50 tuples) and truncates silently.',
      'Either page it to completion (readObjectTuples / readUserTuplesByType, or your own',
      'continuation loop), or annotate the line with `// fga-read-ok: <why one page is enough>`',
      'naming the structural bound (e.g. "one principal on one object — bounded by the model\'s',
      'relation count"). A reason nobody can state is a bug waiting for the 51st tuple.',
    ].join('\n')).toEqual([])
  })
})
