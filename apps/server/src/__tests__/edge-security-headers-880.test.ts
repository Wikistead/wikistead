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
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
    // Measured, not guessed: deploy/caddy/Caddyfile, deploy/k8s/base/ingress.yaml and the chart's
    // ingress template. A refactor that renames or moves them must not turn this file vacuously green.
    expect(files.map((f) => f.path).sort()).toEqual([
      'charts/wikistead/templates/ingress.yaml',
      'deploy/caddy/Caddyfile',
      'deploy/k8s/base/ingress.yaml',
    ])
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
})
