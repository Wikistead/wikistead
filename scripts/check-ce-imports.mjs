#!/usr/bin/env node
// CI guard for the open-core boundary (ADR-011 / ADR-069, #176). Two invariants, enforced on every
// merge (not a one-time manual check):
//
//   1. NO CE code imports the EE namespace `@wikistead-ee/*` (the physically-separated Enterprise
//      packages, #178). Checked across BOTH packages/ and apps/ (a CE app must not pull EE either).
//
//   2. NO CE *library* (a package under packages/ that is NOT itself proprietary) depends on or imports
//      a PROPRIETARY workspace package. The proprietary set is derived from `"private": true` in each
//      package.json (currently `@wikistead/entitlements-cloud`, the Cloud-only tier tables split out in
//      ADR-069/#132) — so future proprietary packages are covered automatically, closing the gap that
//      `license:check` (third-party only) and the old EE-namespace-only pattern left open: an AGPL
//      library could previously `import '@wikistead/entitlements-cloud'` and nothing would fail CI.
//
// Scope note (why apps are exempt from invariant 2): an app (apps/server) is the COMPOSITION ROOT — in
// the Cloud build it legitimately wires the Cloud resolver, and its tests register `cloudEntitlements`
// to simulate Cloud plans. Physically separating that app-level wiring is #178's job (EE physical
// separation), not this lint's. This guard enforces that the AGPL *libraries* stay clean of proprietary
// code, which is the licensing invariant ADR-069 guarantees. Invariant 1 (EE namespace) still applies
// to apps.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const EE_NAMESPACE = '@wikistead-ee/'
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
// #178 / ADR-084 (2026-08-12 addendum): the private overlay's workspace dirs (appended to
// pnpm-workspace.yaml locally by dev-bootstrap.sh — must stay in agreement with it). Absent in a
// CE-only clone and BEFORE the move; discovered when a bootstrapped dev tree has them, so invariant 2
// keeps naming the overlay packages after they leave packages/.
const OVERLAY_DIRS = ['ee/packages-ee', 'ee/apps-ee']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Discover every workspace package (packages/*, apps/*, and any present overlay dirs) with its manifest.
function discoverPackages() {
  const pkgs = []
  for (const dir of ['packages', 'apps', ...OVERLAY_DIRS]) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, 'package.json')
      if (existsSync(manifest)) pkgs.push({ dir, entry, path: join(base, entry), name: readJson(manifest).name, json: readJson(manifest) })
    }
  }
  return pkgs
}

const isOverlay = (p) => OVERLAY_DIRS.some((d) => p.dir === d)
/** Is this path ignored by git? The overlay's whole point is that its bytes never enter CE's objects. */
function gitIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.ts')) files.push(full)
  }
  return files
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A module specifier (import/from/require/dynamic import) referencing one of the given package names.
function specifierPattern(names) {
  const alt = names.map(escapeRe).join('|')
  // `from '<name>'` | `import('<name>')` | `require('<name>')` | `import '<name>'`, and any subpath.
  return new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"](?:${alt})(?:/[^'"]*)?['"]`)
}

const packages = discoverPackages()
// Proprietary = any workspace package marked private (excludes the monorepo root, which isn't a dep).
const proprietary = packages.filter((p) => p.json.private === true && p.name).map((p) => p.name)
// CE libraries = packages/* that are NOT proprietary (the AGPL libs that must stay clean).
const ceLibs = packages.filter((p) => p.dir === 'packages' && !proprietary.includes(p.name))

let failed = false
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true }

// ── Invariant 1: no CE code imports the EE namespace (packages + apps) ──────────────────────────────
// A PROPRIETARY (private) package IS Enterprise — it may reference the EE namespace (sibling EE
// packages, or its own name in docs). So invariant 1 only applies to CE files: skip any file inside a
// proprietary package's directory. This keeps the ban precise — CE (apps + AGPL libraries) must not
// pull EE, while EE↔EE is allowed.
const eeImport = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${escapeRe(EE_NAMESPACE)}`)
const proprietaryPaths = packages.filter((p) => proprietary.includes(p.name)).map((p) => p.path)
for (const dir of ['packages', 'apps']) {
  const base = join(root, dir)
  if (!existsSync(base)) continue
  for (const file of walk(base)) {
    if (proprietaryPaths.some((pp) => file.startsWith(pp + '/') || file.startsWith(pp + '\\'))) continue // EE package → exempt
    // #688: an APP's __tests__ may exercise the EE COMPOSITION (the audit suites assert ledger rows,
    // exactly as the 18 Cloud-plan suites register cloudEntitlements under invariant 2's app
    // exemption). The mirror never ships them — the filter's derived exclusion drops every test-side
    // file matching this same namespace regex — and LIBRARIES stay fully banned: a CE package's tests
    // publishing with an EE import would break every consumer's install.
    if (dir === 'apps' && /[\\/]__tests__[\\/]/.test(file)) continue
    if (eeImport.test(readFileSync(file, 'utf8'))) fail(`CE file imports the EE namespace: ${file.replace(root, '')}`)
  }
}

// ── Invariant 2: no CE library depends on / imports a proprietary package ────────────────────────────
if (proprietary.length > 0) {
  const propImport = specifierPattern(proprietary)
  for (const lib of ceLibs) {
    // 2a. package.json dependency graph (the explicit ask in #176).
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(lib.json[field] || {})) {
        if (proprietary.includes(dep)) fail(`CE library ${lib.name} declares a proprietary dependency in ${field}: ${dep}`)
      }
    }
    // 2b. actual imports in source (a dep could be pulled transitively / via a path without a manifest entry).
    for (const file of walk(lib.path)) {
      if (propImport.test(readFileSync(file, 'utf8'))) fail(`CE library imports a proprietary package: ${file.replace(root, '')}`)
    }
  }
} else {
  console.warn('WARN: no proprietary (private) workspace packages found — invariant 2 has nothing to enforce.')
}

// 3. #178: every proprietary package's bytes must be UNPUBLISHABLE, and there are exactly two ways to
// be that (ADR-084 2026-08-12 addendum) — two-armed on purpose:
//   - IN THE CE TREE (packages/, apps/): its history needs erasing, so it must be on the filter's list.
//     The two lists used to describe the same set with only one of them updating itself — both now read
//     the SAME derivation (proprietaryPackagePaths, exported by the filter); this check stays as the
//     belt that proves the two consumers agree, and it catches the case the derivation cannot: a
//     proprietary package the filter's module fails to see at all.
//   - IN THE OVERLAY (ee/…): its bytes never enter CE's git objects, so the filter has nothing to erase
//     — but ONLY if it is actually gitignored, which is therefore what gets checked. An overlay
//     package that git would track is the worst of both arms: not filtered AND in the objects.
// A package that is neither filtered nor ignored fails; so does an overlay package that is not
// `private: true` (everything under ee/ is proprietary by definition — an unmarked one would dodge
// invariants 1–2's proprietary handling).
if (!existsSync(join(root, 'scripts/prepublish-filter.mjs'))) {
  // The public tree: the filter erased ITSELF (its exclusion list narrates what was removed), so
  // there is nothing for the two consumers to agree on. But a tracked proprietary package in a tree
  // WITHOUT the filter is exactly the leak the filter exists to prevent — their absences must coincide.
  for (const p of packages) {
    if (!isOverlay(p) && p.json.private === true && p.name) {
      fail(`proprietary package ${p.name} (${p.dir}/${p.entry}) exists but the filter does not — this tree reads as a public tree carrying EE bytes`)
    }
  }
} else {
  const { FILTER_PATHS, proprietaryPackagePaths } = await import(pathToFileURL(join(root, 'scripts/prepublish-filter.mjs')).href)
  const derived = new Set(proprietaryPackagePaths(root))
  for (const p of packages) {
    if (isOverlay(p)) {
      if (p.json.private !== true) fail(`overlay package ${p.name ?? p.entry} (${p.dir}/${p.entry}) is not "private": true — everything in the overlay is proprietary`)
      if (!gitIgnored(p.path)) fail(`overlay package ${p.name ?? p.entry} (${p.dir}/${p.entry}) is NOT gitignored — its bytes would enter the CE repo's objects`)
      continue
    }
    if (p.json.private !== true || !p.name) continue
    const rel = `${p.dir}/${p.entry}`
    if (!derived.has(rel)) {
      fail(`proprietary package ${p.name} (${rel}) is not derived by the filter — publishing would ship EE bytes`)
    }
    if (!FILTER_PATHS.includes(rel)) {
      fail(`proprietary package ${p.name} (${rel}) is NOT in the filter's path list — publishing would ship EE bytes`)
    }
  }
}

if (failed) {
  console.error('\nOpen-core boundary violated (ADR-011 / ADR-069). A CE package must not depend on the EE')
  console.error('namespace or on any proprietary (private) workspace package. Fix the violations above.')
  process.exit(1)
}
console.log(`OK: open-core boundary held (checked ${packages.length} packages; proprietary: ${proprietary.join(', ') || 'none'}).`)
