// #697 / ADR-225 §4.2: nothing ships undocumented — the SERVER half of the discovery check.
//
// Registries walked here, and what carries the other server-side surfaces:
//   - admin console tabs — ADMIN_SURFACES is the one registry (the client renders exactly what
//     /admin/surfaces answers), so its keys are the tab list, asked from the code that serves it.
//   - HTTP routes — deliberately NOT re-ledgered: api-inventory-407 already walks the SERVED route
//     table and fails on any route neither in docs/api/openapi.yaml nor explicitly excluded; a
//     second ledger would be a competing exclusion list.
//   - settings / entitlement levers / domain events — item-level mechanical already: gen-docs walks
//     their catalogs into docs/generated/*.md, docs:check keeps the output fresh, and the meta
//     assertion below pins that each of those catalogs stays BOUND in DOC_CODE_MAP (deleting the
//     binding is the one move that would quietly retire the whole mechanism).
import { describe, it, expect } from 'vitest'
import { ADMIN_SURFACES } from '../routes/admin-surfaces.js'
import { TOOLS } from '../routes/mcp.js'
import { IMPORT_ADAPTERS } from '../import/index.js'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { evaluateSurfaceDocs, DOC_CODE_MAP, matchesAny } from '../../../../scripts/doc-code-map.mjs'

const fmt = (violations: { registry: string; id: string | null; why: string }[]) =>
  violations.map((v) => `${v.registry}${v.id ? `:${v.id}` : ''} — ${v.why}`).join('\n')

describe('#697 §4.2: every registered server surface names its docs page', () => {
  it('admin tabs: every ADMIN_SURFACES key has a ledger row (both directions)', () => {
    const discovered = { 'admin-surface': Object.keys(ADMIN_SURFACES) }
    const violations = evaluateSurfaceDocs(discovered)
    expect(violations, fmt(violations)).toEqual([])
  })

  // #729 / ADR-235: CAPABILITIES — what the product can do that has no screen to register. The
  // importer shipped three dialects and nothing asked for a page, because a capability is not a
  // surface anybody enrols; the MCP tools were the other half of the same gap.
  //
  // Both sources are checked in ONE assertion because they share one registry namespace, and the
  // evaluator reports staleness as well as absence — asking it about half the capabilities would
  // report the other half as rows for surfaces that no longer exist. (Measured: splitting this in
  // two failed both ways round.)
  it('capabilities: every MCP tool and import dialect has a ledger row (both directions)', () => {
    const ids = [...TOOLS.map((t) => `mcp:${t.name}`), ...IMPORT_ADAPTERS.map((a) => `import:${a.id}`)]
    // A walk that came back empty would make the assertion below pass while measuring nothing —
    // exactly the failure the ledger exists to prevent, arriving through the ledger's own door.
    expect(TOOLS.length, 'the MCP tool table walked empty — the walk is broken, not the coverage').toBeGreaterThan(5)
    expect(IMPORT_ADAPTERS.length, 'the adapter table walked empty — the walk is broken').toBeGreaterThan(2)
    const violations = evaluateSurfaceDocs({ capability: ids })
    expect(violations, fmt(violations)).toEqual([])
  })

  it('the generated-reference catalogs stay bound in DOC_CODE_MAP', () => {
    // These three registries are covered item-by-item by gen-docs + docs:check; what this pins is
    // the BINDING — the map entry that makes a catalog edit demand its regenerated page in the
    // same change. Sources asserted through the map's own globs, not duplicated paths.
    const generatedSources = [
      'packages/entitlements/src/catalog.ts',
      'packages/events/src/catalog.ts',
      'apps/server/src/settings-catalog.ts',
    ]
    type Entry = { kind: string; code: string[]; doc: string }
    const generated = (DOC_CODE_MAP as Entry[]).filter((e) => e.kind === 'generated')
    for (const src of generatedSources) {
      const bound = generated.some((e) => matchesAny(src, e.code))
      expect(bound, `${src} is no longer bound to a generated docs page in DOC_CODE_MAP`).toBe(true)
    }
  })
})
