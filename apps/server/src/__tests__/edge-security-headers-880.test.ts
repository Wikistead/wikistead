// #880 / ADR-039: every edge in this tree states the same three security headers itself.
//
// THE DEFECT: the compose edge (deploy/caddy/Caddyfile) named nosniff, Referrer-Policy AND HSTS. The
// Kubernetes edges named the first two and left the third to whatever the ingress controller's
// ConfigMap happens to default to. That is not a file in this repository, so an operator can switch
// the pin off — for every tenant at once — and nothing here changes. The two deployments were resting
// on different things, and only one of them was ours.
//
// The pin is a DISCOVERY, not a list: it walks the deploy surfaces and judges whatever states nosniff,
// so a fourth edge added later is measured the day it appears rather than the day somebody remembers
// to extend an array. Enumerating the three known files would have passed a tree with a new edge in it.
//
// It cannot render templates (helm is not on the CI runner), so the chart's tls-conditional half lives
// in `pnpm lint:origin-routes`, which renders with TLS both on and off. This half asks the question
// that needs no tool: does the file say it at all?
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')
const SURFACES = ['deploy', 'charts', 'apps/web']
const TEXTUAL = /\.(ya?ml|conf|tpl|Caddyfile)$|Caddyfile$/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (TEXTUAL.test(name)) out.push(full)
  }
  return out
}

/** Files that take a position on response security headers — i.e. that set nosniff. */
function edgeFiles(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = []
  for (const surface of SURFACES) {
    for (const file of walk(join(ROOT, surface))) {
      const text = readFileSync(file, 'utf8')
      if (/X-Content-Type-Options/i.test(text)) found.push({ path: relative(ROOT, file), text })
    }
  }
  return found
}

describe('edge security headers are stated, not inherited (#880)', () => {
  const files = edgeFiles()

  it('finds the edges at all (a scan of nothing would pass every assertion below)', () => {
    // ⚠️ `deploy/k8s/` does not exist in the public tree — the filter erases it, and #785 caught this
    // file naming it on the day it was written. The other two DO ship, so this takes #704's shape: ask
    // whether the Kubernetes base is there and judge it only when it is, rather than excluding the
    // whole test and leaving the published tree's own edges unguarded.
    const k8s = 'deploy/k8s/base/ingress.yaml'
    const expected = ['charts/wikistead/templates/ingress.yaml', 'deploy/caddy/Caddyfile']
    if (existsSync(join(ROOT, k8s))) expected.push(k8s)
    // Measured, not guessed, and exact for whatever this checkout actually holds: a refactor that
    // renames or moves an edge must not turn this file vacuously green.
    expect(files.map((f) => f.path).sort()).toEqual(expected.sort())
  })

  it.each(files.map((f) => [f.path, f.text] as const))(
    '%s states Referrer-Policy and HSTS alongside nosniff',
    (path, text) => {
      expect(text, `${path} sets nosniff but never names Referrer-Policy`).toMatch(/Referrer-Policy/i)
      expect(text, `${path} sets nosniff but leaves HSTS to the controller's default`).toMatch(/Strict-Transport-Security/i)
    },
  )

  it.each(files.map((f) => [f.path, f.text] as const))(
    '%s pins for long enough, and across the tenant subdomains',
    (path, text) => {
      // Read the whole LINE: Caddy writes the value inside quotes (`Strict-Transport-Security "…"`)
      // and nginx inside a snippet string, so a pattern that stops at the first quote reads the value
      // as empty and then reports max-age=0 — the one verdict this file exists to distinguish.
      for (const value of text.match(/^.*Strict-Transport-Security.*$/gim) ?? []) {
        const age = Number(value.match(/max-age=(\d+)/)?.[1] ?? '0')
        // Below a day the pin expires between two visits; 0 is the documented way to REVOKE one.
        expect(age, `${path}: ${value}`).toBeGreaterThanOrEqual(86400)
        // Sessions live on t1.<host>, so a pin on the apex alone protects nowhere the product runs.
        expect(value, `${path}: ${value}`).toMatch(/includeSubDomains/i)
      }
    },
  )

  // #990 / ADR-277: `frame-ancestors` cannot be carried by the app shell's `<meta>` tag (browsers
  // ignore it there), so it is this file's job — the one directive the app-layer CSP structurally
  // cannot enforce, same reasoning as nosniff/Referrer-Policy/HSTS above.
  it.each(files.map((f) => [f.path, f.text] as const))(
    '%s states frame-ancestors alongside nosniff',
    (path, text) => {
      expect(text, `${path} sets nosniff but never names frame-ancestors`).toMatch(/frame-ancestors/i)
    },
  )

  // #990 / ADR-277/ nginx's `more_set_headers` REPLACES, not merges, a header of the
  // same name a proxied response already carries — `/pub` and `/attachments/:id/inline` each set
  // their own, stricter, path-specific Content-Security-Policy, so setting the edge's
  // `frame-ancestors` via `more_set_headers` would silently erase those. `add_header` ADDS a second
  // CSP header instead (multiple CSP headers intersect — a route's own narrower policy still wins).
  // This guards the MECHANISM, not just the VALUE, since a future edit that "simplifies" this back
  // to more_set_headers would keep every assertion above green while reintroducing exactly the
  // regression this ADR's own review rounds found and fixed for Caddy.
  it.each(
    files.filter((f) => /more_set_headers/i.test(f.text)).map((f) => [f.path, f.text] as const),
  )('%s never SETs Content-Security-Policy (must ADD, not replace, a route\'s own policy)', (path, text) => {
    // The DIRECTIVE call, not prose that merely discusses it — `more_set_headers "Content-Security-
    // Policy: …"` (raw base file) or `more_set_headers \"Content-Security-Policy: …\"` (Helm's quoted
    // Go-template string).
    expect(text).not.toMatch(/more_set_headers\s*\\?["'“]content-security-policy/i)
  })
})
