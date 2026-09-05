// #1139: the pending-removal banner (ADR-275 §4 / #1054) is meant to be tenant-wide — every signed-in
// member should see it, on every route, because a `last_admin` hold means the very admin who could act
// on it may be unable to sign in at all, so the notice cannot afford to hide behind a screen somebody
// happens not to visit. It is rendered inside `AppShell` (`AppShell.tsx`'s `{onLogout && <ScimPendingBanner
// />}`), gated on `onLogout` — the shell's own "a member session owns this" signal. There is no shared
// layout route in this router (`AppRoutes` in `routes.tsx`): every member route's own component decides,
// ad hoc, whether to render `<AppShell>`. `/templates`, `/changes` and `/watches` never did — not a
// mis-gated banner, the shell (and everything it carries, the banner included) was simply absent.
//
// Fixed by wrapping those three in `<AppShell onLogout={logout}>`, matching every other member route's
// existing pattern (`AdminLayout`, `AccountRoot`, `SpaceSettingsRoot`, `PageRoute`, `HomeLanding`).
//
// This pin does not hardcode "these three" — a hand-kept list of routes goes stale the day a new one
// is added: it reads `AppRoutes`'s route table directly and walks EVERY route wrapped in
// `<RequireMember>` (the member-auth gate) that isn't a bare redirect, so a route added next month
// joins the check on its own.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const routesSrc = readFileSync(join(srcRoot, 'app/routes.tsx'), 'utf8')

/** Every .ts/.tsx file under src, so a component's definition can be found regardless of which
 * directory it lives in — routes.tsx pulls from app/, notifications/, settings/ alike. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.includes('.test.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allSourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const FILES = allSourceFiles(srcRoot)

// Extracts just the ONE function's own body (brace-balanced from its opening `{`), not the whole file
// — several targets (`PageRoute`, `HomeLanding`) are file-private functions living in the same large
// `routes.tsx` as every other route, so returning the whole file would let any of them pass by finding
// some OTHER route's <AppShell> instead of their own.
function definitionOf(componentName: string): string {
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8')
    const sig = new RegExp(`(?:export )?function ${componentName}\\b`).exec(text)
    if (!sig) continue
    // Walk from the signature to the function BODY's own opening brace — not the first `{` found,
    // which may belong to a destructured parameter (e.g. `function PageRoute({ pageIdOverride }) {`).
    // Balance parens across the parameter list first, then take the next `{` after that closes.
    let i = sig.index + sig[0].length
    while (text[i] !== '(') i++
    let parenDepth = 1
    for (i++; i < text.length && parenDepth > 0; i++) {
      if (text[i] === '(') parenDepth++
      else if (text[i] === ')') parenDepth--
    }
    while (text[i] !== '{') i++
    let depth = 1
    for (i++; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    return text.slice(sig.index, i)
  }
  throw new Error(`could not find the definition of ${componentName} under src/ — is it declared as a named function?`)
}

const routesBlock = routesSrc.slice(routesSrc.indexOf('<Routes>'), routesSrc.indexOf('</Routes>'))
const routeLines = routesBlock.split('\n').filter((l) => l.includes('<Route ') && l.includes('RequireMember'))

// The innermost component RequireMember wraps: the tag directly BEFORE the closing `</RequireMember>`
// (peeling off an optional `</Suspense>` first). Matched from the closing end rather than the opening
// `<RequireMember>` because `<Suspense fallback={<LazyFallback />}>` has its OWN nested `/>` before its
// own `>`, which defeats a `[^>]*` scan from the front. A route with attributes on its element (the
// `<Navigate to="..." replace />` back-compat redirect) does not match `<(\w+)\s*/>` — self-closing
// with nothing between the name and `/>` — and is correctly excluded: it renders no page of its own.
const targets = routeLines
  .map((line) => {
    const m = line.match(/<(\w+)\s*\/>\s*(?:<\/Suspense>)?<\/RequireMember>/)
    return m ? m[1] : null
  })
  .filter((name): name is string => name !== null)

describe('#1139: every member-authenticated route wraps its content in AppShell', () => {
  it('the route table was actually found and walked, not a walk over nothing', () => {
    expect(routeLines.length, 'the route table must have been found and must list at least one member route').toBeGreaterThan(5)
    expect(targets.length, 'must have extracted at least the three routes #1139 reports as broken').toBeGreaterThanOrEqual(3)
    expect(targets, 'the three routes #1139 reports missing the banner must still be in the table').toEqual(
      expect.arrayContaining(['TemplatesRoute', 'RecentChangesRoute', 'WatchListRoute']),
    )
  })

  // A route's top-level component may be a thin nested-router shim (`AdminRoot`, `AccountRoot`,
  // `SpaceSettingsRoot`) that renders its OWN <Routes> and delegates the actual shell to a Layout
  // component further down (`element={<AdminLayout />}` wrapping the tab routes) — the shell still
  // covers every one of those routes (a nested route's content renders as the Layout's own <Outlet/>),
  // so one level of "does this hand off to a Layout" indirection is followed before failing.
  function rendersAppShellEventually(name: string, seen: Set<string> = new Set()): boolean {
    if (seen.has(name)) return false // guards a cycle rather than looping forever
    seen.add(name)
    const body = definitionOf(name)
    if (body.includes('<AppShell')) return true
    const layoutMatch = body.match(/element=\{<(\w*Layout)\s*\/>\}/)
    return layoutMatch ? rendersAppShellEventually(layoutMatch[1], seen) : false
  }

  for (const name of targets) {
    it(`${name} (a member-only route) renders <AppShell>, itself or via its Layout`, () => {
      expect(rendersAppShellEventually(name), `${name} never reaches an <AppShell> render`).toBe(true)
    })
  }
})
