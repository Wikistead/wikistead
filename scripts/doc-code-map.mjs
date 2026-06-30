// Code-region → docs-page map + the linkage evaluator (#139 / ADR-080 doc↔code linkage).
//
// The map binds a designated code region (API / macros / editor features / settings /
// entitlement levers) to the docs page that documents it. The CI check
// (scripts/check-doc-links.mjs) computes the changed files of a PR and FLAGS any entry
// whose code region changed while its docs page did NOT — so a feature change and its
// doc change stay in the same change flow (they cannot be decoupled silently).
//
// `kind`:
//   'generated' — the docs page is AUTO-GENERATED in THIS repo (docs/generated/**). Its
//                 freshness is additionally guaranteed by `pnpm docs:check`; the map check
//                 still flags a code change that lands without the regenerated output.
//   'authored'  — the docs page is HAND-WRITTEN prose in the separate wikistead-docs SSG
//                 repo (ADR-080: the docs repo is NOT a submodule). The check runs in the
//                 combined CI checkout where both repos' changed files are visible.
//
// The evaluator is PURE (changedFiles + map → violations) so it is verifiable with
// synthetic inputs regardless of which repos are checked out; the script is the thin git
// adapter around it.

// Each entry: code globs (relative to the app repo) → the docs page that must move with them.
export const DOC_CODE_MAP = [
  {
    label: 'entitlement levers',
    kind: 'generated',
    code: ['packages/entitlements/src/index.ts', 'packages/entitlements/src/catalog.ts'],
    doc: 'docs/generated/entitlement-levers.md',
  },
  {
    label: 'domain events',
    kind: 'generated',
    code: ['packages/events/src/index.ts', 'packages/events/src/catalog.ts'],
    doc: 'docs/generated/domain-events.md',
  },
  {
    label: 'account settings',
    kind: 'generated',
    code: ['apps/server/src/settings-catalog.ts'],
    doc: 'docs/generated/account-settings.md',
  },
  // Authored pages live in the wikistead-docs repo (paths are docs-repo-relative). Seeded
  // for the designated regions; the check binds them in the combined CI checkout.
  {
    label: 'editor macros',
    kind: 'authored',
    code: ['apps/web/src/editor/macros/**'],
    doc: 'wikistead-docs/src/content/docs/editor/macros.md',
  },
  {
    label: 'HTTP API routes',
    kind: 'authored',
    code: ['apps/server/src/routes/**'],
    doc: 'wikistead-docs/src/content/docs/api/reference.md',
  },
  {
    label: 'account settings',
    kind: 'authored',
    code: ['apps/web/src/settings/**'],
    doc: 'wikistead-docs/src/content/docs/settings/account.md',
  },
]

// Minimal glob → RegExp (no dependency). Supports `**` (any path segments incl. `/`),
// `*` (any chars except `/`), and literal path separators. Anchored to the full path.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          // `**/` → zero or more leading path segments
          i++
          re += '(?:.*/)?'
        } else {
          // trailing `**` → anything, including `/` (the rest of the path)
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$+?.()|[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file))
}

// Evaluate the linkage against a set of changed files. Returns one violation per map
// entry whose code region changed but whose docs page did NOT — i.e. code and docs were
// decoupled in this change.
export function evaluateDocLinks(changedFiles, map = DOC_CODE_MAP) {
  const changed = new Set(changedFiles)
  const violations = []
  for (const entry of map) {
    const changedCode = changedFiles.filter((f) => matchesAny(f, entry.code))
    if (changedCode.length === 0) continue // region untouched → nothing to bind
    if (changed.has(entry.doc)) continue // doc moved with the code → ok
    violations.push({ label: entry.label, kind: entry.kind, doc: entry.doc, changedCode })
  }
  return violations
}
