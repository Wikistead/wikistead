// #693: an EE lever's ENFORCEMENT must not live in the CE tree.
//
// The defect this catches is #688's, at commit time instead of eight months later: code that gates on
// a Business-only entitlement (`entitlements.auditLog`, `resolveEntitlements(...).scim`, …) sitting in
// the public tree — locked by plan, bytes public. `check-ce-imports` sees imports and the filter sees
// publish time; neither sees this SEMANTIC — "who reads an EE lever's value".
//
// The deny-set is DERIVED from the catalog's `edition: 'ee'` rows, never listed here: a sixth EE lever
// is guarded the day it is declared. Mentions in comments, the catalog itself and generated docs are
// fine — what is refused is a VALUE READ (`.<lever>` as a property access) in CE source.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// ── the deny-set, from the catalog ────────────────────────────────────────────────────────────────
// Textual extraction rather than import: this script runs pre-build (no dist), and the catalog is a
// literal. An `edition: 'ee'` line belongs to the lever block opened most recently above it.
const catalog = readFileSync(join(root, 'packages/entitlements/src/catalog.ts'), 'utf8')
const eeLevers = []
{
  let current = null
  for (const line of catalog.split('\n')) {
    const open = line.match(/^ {2}([A-Za-z0-9_]+): \{/)
    if (open) current = open[1]
    if (current && /^ {4}edition: 'ee',?$/.test(line.trim().length ? line : '')) eeLevers.push(current)
  }
}
if (eeLevers.length === 0) {
  console.error('check-ee-lever-placement: the catalog declares no EE levers — the guard would be vacuous.')
  console.error('If every EE lever was genuinely retired, retire this script in the same commit.')
  process.exit(1)
}

// ── the CE tree ───────────────────────────────────────────────────────────────────────────────────
// apps/ and packages/ are the public tree. Private trees (the ee/ overlay, node_modules, dist) are
// exempt: an EE lever's enforcement is exactly what belongs THERE.
const SCAN_ROOTS = ['apps', 'packages'].filter((d) => existsSync(join(root, d)))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage'])

/** A PRIVATE package (the ee-server seam package lives under packages/ physically) is not CE. */
function isPrivatePkg(dir) {
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) return false
  try {
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    return pkg.private === true && String(pkg.name ?? '').startsWith('@wikistead-ee/')
  } catch { return false }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (isPrivatePkg(p)) continue; yield* walk(p) }
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name)) yield p
  }
}

/** Strip comments so a sentence ABOUT a lever is not a read OF it (#667's sweep technique). */
/**
 * A DECLARED seam read: a CE line may read an EE lever's value when it carries the pragma
 * `#693 seam:` (same line or the line above) — the CE side composing "is this door offered" while the
 * door's BYTES stay in the overlay. The pragma makes every such read a reviewable declaration in the
 * diff; an undeclared read stays red, which is the whole guard.
 */
function seamDeclared(rawLines, lineNo) {
  const here = rawLines[lineNo - 1] ?? ''
  const above = rawLines[lineNo - 2] ?? ''
  return here.includes('#693 seam:') || above.includes('#693 seam:')
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length))
}

const ALLOW_FILES = new Set([
  join(root, 'packages/entitlements/src/catalog.ts'), // the declaration itself
])

const hits = []
const seams = []
for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(join(root, scanRoot))) {
    if (ALLOW_FILES.has(file)) continue
    // Tests may exercise the seam (they register cloud/EE behaviour to simulate plans); the invariant
    // is about SHIPPED CE bytes. Same line check-ce-imports draws for the composition root's tests.
    if (/__tests__|\.test\.|\.spec\./.test(file)) continue
    const raw = readFileSync(file, 'utf8')
    const rawLines = raw.split('\n')
    const src = stripComments(raw)
    for (const lever of eeLevers) {
      // a VALUE READ: `.lever` as property access (entitlements.auditLog, resolveEntitlements(x).scim);
      // word-bounded so `.auditLogSomething` does not match.
      const re = new RegExp(String.raw`\.${lever}\b`, 'g')
      let m
      while ((m = re.exec(src)) !== null) {
        const line = src.slice(0, m.index).split('\n').length
        if (seamDeclared(rawLines, line)) {
          seams.push(`${file.slice(root.length + 1)}:${line}: .${lever}`)
          continue
        }
        hits.push(`${file.slice(root.length + 1)}:${line}: reads EE lever '.${lever}' in the CE tree`)
      }
    }
  }
}

if (hits.length) {
  console.error('check-ee-lever-placement: EE-lever ENFORCEMENT found in the CE tree (#693 / #688):')
  for (const h of hits) console.error('  ' + h)
  console.error(`Levers guarded (from catalog edition:'ee'): ${eeLevers.join(', ')}`)
  console.error('The code that reads an EE lever belongs in the private overlay (ee/). See the project design notes and #688.')
  process.exit(1)
}
console.log(`check-ee-lever-placement OK — no undeclared CE read of ${eeLevers.length} EE levers (${eeLevers.join(', ')}).`)
if (seams.length) {
  // never silent: the declared seam reads are the inventory a reviewer challenges
  console.log(`declared seam reads (${seams.length}):`)
  for (const x of seams) console.log('  ' + x)
}
