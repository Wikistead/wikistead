// "Code is truth" domain-events doc generation (#139 / ADR-080 doc↔code linkage). Coverage
// is enforced at compile time by `Record<DomainEvent['type'], string>` (a new event is a
// type error until documented); this verifies the render is deterministic and the committed
// generated Markdown is NOT stale (the same guard `pnpm docs:check` runs in CI).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { EVENT_CATALOG, renderEventsMarkdown } from '@wikistead/events'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const generatedPath = join(repoRoot, 'docs/generated/webhook-events.md')

describe('domain events doc (#139 / ADR-080 doc↔code linkage)', () => {
  it('every catalogued event has a non-empty description', () => {
    const entries = Object.entries(EVENT_CATALOG)
    expect(entries.length).toBeGreaterThan(20) // the bus is substantial — sanity floor
    for (const [type, desc] of entries) expect(desc, type).toBeTruthy()
  })

  it('render is deterministic and lists representative events', () => {
    const a = renderEventsMarkdown()
    expect(a).toBe(renderEventsMarkdown())
    for (const t of ['page.created', 'member.added', 'scim_token.created', 'tenant.plan_changed']) {
      expect(a).toContain(`\`${t}\``)
    }
    expect(a).toContain('AUTO-GENERATED')
  })

  it('committed generated doc is NOT stale (CI stale-guard)', () => {
    expect(readFileSync(generatedPath, 'utf8')).toBe(renderEventsMarkdown())
  })
})
