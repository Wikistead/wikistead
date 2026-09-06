// "Code is truth" entitlement-levers doc generation (#139 / ADR-080 doc↔code linkage).
// Verifies the linkage holds at runtime: the catalog covers EXACTLY the resolver's
// levers (no drift between the Entitlements/UNLIMITED shape and the documented set),
// the generator is deterministic, and the committed generated Markdown is NOT stale
// (the same guard `pnpm docs:check` runs in CI — this fails the test if code changed
// without `pnpm docs:gen`).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { LEVER_CATALOG, UNLIMITED, renderEntitlementsMarkdown } from '@wikistead/entitlements'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const generatedPath = join(repoRoot, 'docs/generated/plan-contents.md')

describe('entitlement levers doc (#139 / ADR-080 doc↔code linkage)', () => {
  it('catalog covers EXACTLY the resolver levers (no doc↔code drift)', () => {
    const catalogKeys = Object.keys(LEVER_CATALOG).sort()
    const leverKeys = Object.keys(UNLIMITED).sort()
    // A lever added to Entitlements/UNLIMITED but not catalogued (or vice-versa) must
    // fail here — the type-level Record<keyof Entitlements> catches the interface side,
    // this catches the UNLIMITED side and any value-shape divergence.
    expect(catalogKeys).toEqual(leverKeys)
  })

  it('every lever has non-empty doc fields', () => {
    for (const [key, doc] of Object.entries(LEVER_CATALOG)) {
      expect(doc.title, key).toBeTruthy()
      expect(doc.summary, key).toBeTruthy()
      expect(doc.enforcedAt, key).toBeTruthy()
      expect(doc.downgrade, key).toBeTruthy()
    }
  })

  it('render is deterministic and lists every lever key', () => {
    const a = renderEntitlementsMarkdown()
    const b = renderEntitlementsMarkdown()
    expect(a).toBe(b) // reproducible (no Date/locale dependence)
    for (const key of Object.keys(LEVER_CATALOG)) {
      expect(a).toContain(`\`${key}\``)
    }
    expect(a).toContain('AUTO-GENERATED')
  })

  it('committed generated doc is NOT stale (CI stale-guard)', () => {
    const committed = readFileSync(generatedPath, 'utf8')
    expect(committed).toBe(renderEntitlementsMarkdown())
  })

  // #1174: `UNLIMITED[key] === true` says the PLAN would not restrict a lever on self-host — it does
  // not say self-host has the code to run it. An `edition: 'ee'` lever has none at all outside the
  // private overlay, so the doc must never print its self-host cell as though it were available.
  it('an EE-edition lever is never marked available in the self-host column (#1174)', () => {
    const rendered = renderEntitlementsMarkdown()
    const eeKeys = Object.entries(LEVER_CATALOG)
      .filter(([, doc]) => doc.edition === 'ee')
      .map(([key]) => key)
    expect(eeKeys.length).toBeGreaterThan(0) // the pin is vacuous if this catalog ever loses its EE rows
    for (const key of eeKeys) {
      const row = rendered.split('\n').find((line) => line.includes(`\`${key}\``))
      expect(row, key).toBeTruthy()
      expect(row, key).not.toMatch(/\|\s*Enabled\s*\|/)
      expect(row, key).toContain('Not on self-host (EE-only)')
    }
  })
})
