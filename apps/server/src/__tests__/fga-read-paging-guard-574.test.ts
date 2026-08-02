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
// #574 review 2: `infra/openfga` was outside the scan, and it held TWO genuinely truncating
// reads — the ADR-103 and ADR-199 migrations, where losing tuple 51+ means the model flip silently
// takes access away. A guard that skips the directory holding the migrations is not a guard.
const SCAN = ['apps/server/src', 'apps/collab/src', 'packages', 'infra/openfga']
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', 'coverage'])

// #574 review 2: an exact-match receiver list let the repo's OWN mainstream spellings through —
// `req.server.fga.read(`, `(fga as any).read(`, `this.fga.read(`, `fga?.read(`, a typed alias, a
// destructured one. None of those is adversarial; they are just how the code is written. So the
// receiver is NORMALISED and matched by SEGMENT: strip the casts, the optional chaining and the
// parens, then ask whether any part of the dot chain is an FGA client name.
const CLIENT_NAMES = ['fga', 'fgaClient', 'client', 'authz']

/** `const authz = app.fga`, `const authz: OpenFgaClient = app.fga`, `const { fga: authz } = deps` —
 *  an alias inherits the requirement, however it was spelled. */
function aliasesIn(src: string): string[] {
  const out: string[] = []
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g
  for (let m = assign.exec(src); m; m = assign.exec(src)) {
    if (isClient(m[2]!.trim()) && !out.includes(m[1]!)) out.push(m[1]!)
  }
  const destructured = /\{\s*fga\s*:\s*([A-Za-z_$][\w$]*)\s*\}/g
  for (let m = destructured.exec(src); m; m = destructured.exec(src)) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

/** Is this expression an FGA client? Casts, optional chaining, parens and `await` are noise. */
function isClient(expr: string, extra: readonly string[] = []): boolean {
  const bare = expr
    .replace(/^await\s+/, '')
    .replace(/\bas\s+[A-Za-z_$][\w$.<>[\]| ]*/g, '')
    .replace(/[()!?]/g, '')
    .trim()
  const segments = bare.split('.').map((x) => x.trim()).filter(Boolean)
  return segments.some((seg) => CLIENT_NAMES.includes(seg) || extra.includes(seg))
}

export interface Offender { file: string; line: number; text: string }

/** Exported so the scanner itself can be tested against known-bad shapes (see below). */
export function scanSource(src: string, file = '<memory>'): Offender[] {
  const aliases = aliasesIn(src)
  const offenders: Offender[] = []
  const lines = src.split('\n')
  // every `.read(` in the file, wherever the receiver sits relative to the dot
  const call = /\.\s*read\s*\(/g
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const lineNo = src.slice(0, m.index).split('\n').length
    const line = lines[lineNo - 1] ?? ''
    // a mention inside a comment or a string is prose, not a call (the packages' own doc comment says
    // "never a bare fga.read", and the review found it one line-shift away from a false red)
    const col = m.index - (src.lastIndexOf('\n', m.index - 1) + 1)
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.slice(0, col).split(/['"`]/).length % 2 === 0) continue
    // what precedes the dot, ignoring whitespace/newlines a formatter may have inserted
    const before = src.slice(0, m.index).replace(/\s+$/, '')
    // Two readings of "what is the receiver", because a cast wraps it in parens: the dot chain that
    // ends here, and the parenthesised expression that ends here. Either being an FGA client counts —
    // `(fga as any)` reads as the identifier `any` under the first reading alone.
    const chain = /([A-Za-z_$][\w$?!)\]]*(?:\s*\.\s*[A-Za-z_$][\w$?!)\]]*)*)$/.exec(before)?.[1]
    const paren = /\(([^()]*)\)$/.exec(before)?.[1]
    const recvs = [chain, paren].filter((x): x is string => !!x)
    if (!recvs.some((r) => isClient(r, aliases))) continue // not ours: fileHandle.read, stream.read, a mock…
    // The exemption has to be ATTACHED to the call, not merely nearby: a ±7 line window let a new
    // unannotated read hide beside an annotated one (measured in the review).
    const near = lines.slice(Math.max(0, lineNo - 3), lineNo + 2).join('\n')
    if (/continuationToken|continuation_token/.test(lines.slice(Math.max(0, lineNo - 4), lineNo + 6).join('\n'))) continue // a paginating loop
    if (/fga-read-ok:/.test(near)) continue // the author stated the structural bound, next to the call
    offenders.push({ file, line: lineNo, text: line.trim() })
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

  // #574 review 2: every one of these slipped through the exact-match receiver list, and none of
  // them is adversarial — the first is how this repo's own route handlers reach the client, and the
  // second is what both infra migrations were already written as.
  it('catches the spellings this repo actually uses', () => {
    const shapes: Record<string, string> = {
      'server property chain': `const x = await req.server.fga.read({ object: 'page:1' })`,
      'cast': `const x = await (fga as any).read({ object: 'page:1' })`,
      'typed cast': `const x = await (app.fga as OpenFgaClient).read({ object: 'page:1' })`,
      'this property': `const x = await this.fga.read({ object: 'page:1' })`,
      'optional chain': `const x = await fga?.read({ object: 'page:1' })`,
      'non-null': `const x = await fga!.read({ object: 'page:1' })`,
      'typed alias': `const authz: OpenFgaClient = app.fga\nconst x = await authz.read({ object: 'page:1' })`,
      'destructured alias': `const { fga: authz } = deps\nconst x = await authz.read({ object: 'page:1' })`,
    }
    for (const [name, src] of Object.entries(shapes)) {
      expect(scanSource(src).length, `${name}: an unannotated read must be reported`).toBe(1)
    }
  })

  it('an annotation must be attached to the call, not merely in the neighbourhood', () => {
    // measured in the review: with a ±7 line window, a new unannotated read could hide beside an
    // annotated one and the guard stayed green
    const hiding = [
      `// fga-read-ok: bounded, honestly`,
      `const a = await fga.read({ object: 'page:1', relation: 'private' })`,
      ``, ``, ``, ``,
      `const b = await fga.read({ object: 'page:2' })`, // this one says nothing
    ].join('\n')
    expect(scanSource(hiding).map((o) => o.line), 'only the unannotated call is reported').toEqual([7])
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
