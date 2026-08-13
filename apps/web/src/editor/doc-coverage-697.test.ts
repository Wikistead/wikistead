// #697 / ADR-225 §4.2: nothing ships undocumented — the WEB half of the discovery check.
//
// The surfaces are walked from the product's own registries, never listed here: the macro registry
// (import-side-effect registration, then ask it) and the router table (the one JSX file that IS the
// web app's screen registry — there is no composition to miss, so reading that single file is the
// registry walk, not a filesystem guess). What each surface must have is a row in SURFACE_DOCS
// (scripts/doc-code-map.mjs): a docs page, or an explicit none:<reason>. A surface registered
// tomorrow with no row turns this red tomorrow — the inversion ADR-225 §4.2 asks for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import './macros/index' // side effect: registers every shipped macro
import { registeredFenceLangs, registeredDirectiveNames } from './macros/registry'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { evaluateSurfaceDocs, SURFACE_DOCS } from '../../../../scripts/doc-code-map.mjs'

const fmt = (violations: { registry: string; id: string | null; why: string }[]) =>
  violations.map((v) => `${v.registry}${v.id ? `:${v.id}` : ''} — ${v.why}`).join('\n')

describe('#697 §4.2: every registered web surface names its docs page', () => {
  it('macros: every registered fence language and directive name has a ledger row', () => {
    const discovered = {
      macro: [
        ...registeredFenceLangs().map((l: string) => `fence:${l}`),
        ...registeredDirectiveNames().map((n: string) => `directive:${n}`),
      ],
    }
    const violations = evaluateSurfaceDocs(discovered)
    expect(violations, fmt(violations)).toEqual([])
  })

  it('web routes: every <Route path> in the router registry has a ledger row', () => {
    // routes.tsx is the single top-level router; tab-level screens under /admin/* and the settings
    // roots are covered by their own registries (admin-surface in the server suite) — the ledger
    // binds each top-level screen once, at the path the router registers.
    const src = readFileSync(resolve(import.meta.dirname, '../app/routes.tsx'), 'utf8')
    const paths = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!)
    const discovered = { 'web-route': [...new Set(paths)] }
    const violations = evaluateSurfaceDocs(discovered)
    expect(violations, fmt(violations)).toEqual([])
  })

  it('the ledger itself carries no empty registry (a section with zero rows guards nothing)', () => {
    for (const [registry, rows] of Object.entries(SURFACE_DOCS as Record<string, Record<string, string>>)) {
      expect(Object.keys(rows).length, `SURFACE_DOCS.${registry} is empty`).toBeGreaterThan(0)
    }
  })
})
