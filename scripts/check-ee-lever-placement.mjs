// #693: an EE lever's ENFORCEMENT must not live in the CE tree.
//
// The defect this catches is #688's, at commit time instead of eight months later: code that gates on
// a Business-only entitlement (`entitlements.auditLog`, `resolveEntitlements(...).scim`, …) sitting in
// the public tree — locked by plan, bytes public. `check-ce-imports` sees imports and the filter sees
// publish time; neither sees this SEMANTIC — "who reads an EE lever's value".
//
// The deny-set is DERIVED from the catalog's `edition: 'ee'` rows, never listed here: a sixth EE lever
// is guarded the day it is declared. What is refused is a VALUE READ in CE source, in every spelling
// TS makes ordinary (the first version saw only `.lever` and blessed i18n STRINGS as reads):
//   - property access:        entitlements.samlSso
//   - bracket access:         entitlements['samlSso']
//   - assignment destructure: const { samlSso } = resolveEntitlements(plan)
// Mentions in comments, string literals (i18n keys!), the catalog itself and generated docs are fine.
// There is NO allow mechanism (the `#693 seam:` pragma is retired,): the one legitimate CE need
// — "is this door offered" — goes through a registered predicate whose read lives in ee/ (the
// samlSso seam, auth/saml-entitlement.ts), so a hit here is always a defect to fix, never to declare.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The deny-set, from the catalog. Textual extraction rather than import: this runs pre-build. */
export function eeLeversOf(root) {
  const catalog = readFileSync(join(root, 'packages/entitlements/src/catalog.ts'), 'utf8')
  const levers = []
  let current = null
  for (const line of catalog.split('\n')) {
    const open = line.match(/^ {2}([A-Za-z0-9_]+): \{/)
    if (open) current = open[1]
    if (current && /^ {4}edition: 'ee',?$/.test(line.trim().length ? line : '')) levers.push(current)
  }
  return levers
}

/** Blank comments (a sentence ABOUT a lever is not a read of it) — newlines kept for line numbers. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length))
}

/**
 * Blank string literal CONTENTS (quotes stay, so bracket access is detected on the un-stripped
 * text in its own pass).'s headline false positive: `t("adminNav.analytics")` matched
 * `\.analytics\b` and the "fix" was a pragma describing code that did not exist.
 */
export function stripStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        if (src[i] === c) { out += c; i++; break }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

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

const lineOf = (src, index) => src.slice(0, index).split('\n').length

/**
 * Scan the CE tree under `root` for EE-lever value reads. Pure of process state so the pin test
 * (`ee-lever-lint-693`) drives it against scratch trees — the guard's own refusals are measured,
 * not assumed. Throws when the catalog declares no EE lever (a guard with an empty deny-set is
 * vacuously green about everything — that silence must be loud).
 */
export function scanForEeLeverReads(root = repoRoot) {
  const eeLevers = eeLeversOf(root)
  if (eeLevers.length === 0) {
    throw new Error('the catalog declares no EE levers — the guard would be vacuous. If every EE lever was genuinely retired, retire this script in the same commit.')
  }
  const scanRoots = ['apps', 'packages'].filter((d) => existsSync(join(root, d)))
  const allowFiles = new Set([join(root, 'packages/entitlements/src/catalog.ts')])
  const hits = []
  for (const scanRoot of scanRoots) {
    for (const file of walk(join(root, scanRoot))) {
      if (allowFiles.has(file)) continue
      // Tests may exercise the seam (they register EE behaviour to simulate plans); the invariant is
      // about SHIPPED CE bytes. Same line check-ce-imports draws for the composition root's tests.
      if (/__tests__|\.test\.|\.spec\./.test(file)) continue
      const raw = readFileSync(file, 'utf8')
      const noComments = stripComments(raw)
      const noStrings = stripStrings(noComments)
      const rel = file.slice(root.length + 1)
      for (const lever of eeLevers) {
        // Property access — on comment+string-stripped text so i18n keys cannot match.
        for (const m of noStrings.matchAll(new RegExp(String.raw`\.${lever}\b`, 'g'))) {
          hits.push({ file: rel, line: lineOf(noStrings, m.index), lever, form: 'property access' })
        }
        // Bracket access — quotes are the point, so this runs on comment-stripped text only.
        for (const m of noComments.matchAll(new RegExp(String.raw`\[\s*['"]${lever}['"]\s*\]`, 'g'))) {
          hits.push({ file: rel, line: lineOf(noComments, m.index), lever, form: 'bracket access' })
        }
        // Assignment destructuring — `const { ..., lever, ... } = resolveEntitlements(...)`.
        for (const m of noStrings.matchAll(new RegExp(String.raw`\{[^{}\n]*\b${lever}\b[^{}\n]*\}\s*=`, 'g'))) {
          hits.push({ file: rel, line: lineOf(noStrings, m.index), lever, form: 'destructuring' })
        }
      }
    }
  }
  return { eeLevers, hits }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  let result
  try {
    result = scanForEeLeverReads()
  } catch (e) {
    console.error(`check-ee-lever-placement: ${e.message}`)
    process.exit(1)
  }
  if (result.hits.length) {
    console.error('check-ee-lever-placement: EE-lever ENFORCEMENT found in the CE tree (#693 / #688):')
    for (const h of result.hits) console.error(`  ${h.file}:${h.line}: reads EE lever '${h.lever}' (${h.form})`)
    console.error(`Levers guarded (from catalog edition:'ee'): ${result.eeLevers.join(', ')}`)
    console.error('The code that reads an EE lever belongs in the private overlay (ee/), or behind a registered predicate whose read lives there (the samlSso seam is the template). See the project design notes and #688.')
    process.exit(1)
  }
  console.log(`check-ee-lever-placement OK — no CE read of ${result.eeLevers.length} EE levers (${result.eeLevers.join(', ')}), in any spelling (property / bracket / destructuring).`)
}
