// #574: the DISCOVERY pin for OpenFGA's silent truncation. Read answers ONE page (default 50) and
// drops the rest without a word unless continuation_token is followed — four separate tickets have
// now been caused by that (#540, #545, #553, #574), because nothing in the call site's shape says
// "this is a page". An enumerated list of known-bad call sites cannot help: it passes the N+1th
// (the #544 lesson). So this scans the SOURCE for reads on an FGA client and requires each one to be
// either
//   - paginated (a continuation loop within a few lines), or
//   - annotated `// fga-read-ok: <why one page is enough>` — a structural bound, in words, near the
//     call. The bound must come from model.fga: a filtered Read expands NOTHING, so what can appear
//     is decided by the relation's DIRECT types (the #574 review found me asserting the
//     opposite about `page#view_base`, which accepts only `user:*`).
//
// #574 review: the first version of this scanner walked LINE BY LINE, and two shapes walked
// straight past it — a call split across lines (`app.fga\n  .read({…})`, which is just what a
// formatter does to a long line) and an aliased receiver (`const authz = app.fga`). Both were
// measured slipping through. A guard whose whole purpose is "the N+1th call cannot sneak in" cannot
// be defeated by pressing Enter, so the scan now works on the joined text: it finds EVERY `.read(`
// and decides the receiver afterwards, with the alias set discovered from the file itself.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../../..', import.meta.url).pathname // repo root
const SCAN = ['apps/server/src', 'apps/collab/src', 'packages']
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', 'coverage'])

// The receivers that ARE an FGA client. `client` stays for the packages, where the parameter is
// named that; a local alias of any of these is added per file by aliasesIn().
const BASE_RECEIVERS = ['fga', 'fgaClient', 'app.fga', 'deps.fga', 'client']

/** `const authz = app.fga` / `let x = fgaClient` — the alias inherits the requirement. */
function aliasesIn(src: string): string[] {
  const out: string[] = []
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*)\s*[;\n]/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (BASE_RECEIVERS.includes(m[2]!) && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

export interface Offender { file: string; line: number; text: string }

/** Exported so the scanner itself can be tested against known-bad shapes (see below). */
export function scanSource(src: string, file = '<memory>'): Offender[] {
  const receivers = [...BASE_RECEIVERS, ...aliasesIn(src)]
  const offenders: Offender[] = []
  const lines = src.split('\n')
  // every `.read(` in the file, wherever the receiver sits relative to the dot
  const call = /\.\s*read\s*\(/g
  for (let m = call.exec(src); m; m = call.exec(src)) {
    // what precedes the dot, ignoring the whitespace/newlines a formatter may have inserted
    const before = src.slice(0, m.index).replace(/\s+$/, '')
    const recv = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)$/.exec(before)?.[1]
    // not one of ours (fileHandle.read, stream.read, a mock…) — only FGA clients are in scope
    if (!recv || !receivers.includes(recv)) continue
    const lineNo = src.slice(0, m.index).split('\n').length
    const window = lines.slice(Math.max(0, lineNo - 7), lineNo + 8).join('\n')
    if (/continuationToken|continuation_token/.test(window)) continue // a paginating loop
    if (/fga-read-ok:/.test(window)) continue // the author stated the structural bound
    offenders.push({ file, line: lineNo, text: (lines[lineNo - 1] ?? '').trim() })
  }
  return offenders
}

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
        const src = readFileSync(file, 'utf8')
        for (const o of scanSource(src, relative(ROOT, file))) offenders.push(`${o.file}:${o.line}  ${o.text}`)
      }
    }
    expect(offenders, [
      'An FGA read here returns ONE page (50 tuples) and truncates silently.',
      'Either page it to completion (readObjectTuples / readUserTuplesByType, or your own',
      'continuation loop), or annotate the call with `// fga-read-ok: <why one page is enough>`',
      'naming the structural bound FROM model.fga — a filtered Read expands nothing, so the bound is',
      'the relation\'s direct types (e.g. "view_base accepts only user:* — at most one tuple").',
      'A reason nobody can state is a bug waiting for the 51st tuple.',
    ].join('\n')).toEqual([])
  })

  // The guard guarding the guard. These are the exact shapes the review measured slipping
  // through the line-by-line version; if the scanner regresses to it, these turn red rather than the
  // repo silently losing coverage.
  it('catches the shapes a line-by-line scan missed', () => {
    const plain = `const x = await fga.read({ object: 'page:1' })`
    const split = `const x = await app.fga\n  .read({ object: 'page:1' })`
    const aliased = `const authz = app.fga\nconst x = await authz.read({ object: 'page:1' })`
    for (const [name, src] of [['same line', plain], ['split across lines', split], ['aliased receiver', aliased]] as const) {
      expect(scanSource(src).length, `an unannotated read (${name}) must be reported`).toBe(1)
    }
  })

  it('does not report a paginating loop, an annotated call, or somebody else\'s .read', () => {
    const paged = `let continuationToken: string | undefined\ndo {\n  const r = await fga.read({ object: 'page:1', continuationToken })\n  continuationToken = r.continuationToken\n} while (continuationToken)`
    const annotated = `// fga-read-ok: view_base accepts only user:* — at most one tuple\nconst x = await fga.read({ object: 'page:1', relation: 'view_base' })`
    const foreign = `const buf = await fileHandle.read({ length: 10 })\nconst s = await stream.read()`
    expect(scanSource(paged), 'a continuation loop is the point, not a violation').toEqual([])
    expect(scanSource(annotated), 'a stated structural bound is accepted').toEqual([])
    expect(scanSource(foreign), 'only FGA clients are in scope').toEqual([])
  })
})
