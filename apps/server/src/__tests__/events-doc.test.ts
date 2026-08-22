// "Code is truth" domain-events doc generation (#139 / ADR-080 doc↔code linkage). Coverage
// is enforced at compile time by `Record<DomainEvent['type'], string>` (a new event is a
// type error until documented); this verifies the render is deterministic and the committed
// generated Markdown is NOT stale (the same guard `pnpm docs:check` runs in CI).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { EVENT_CATALOG, renderEventsMarkdown } from '@wikistead/events'
// #862: the page says which events reach a webhook, and the server owns that decision. Passed here
// rather than defaulted — this guard used to call the renderer bare, so it compared the committed page
// against one that claimed every event was delivered, and the stale-guard is where that shows up.
import { EGRESS } from '../webhooks/egress.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const generatedPath = join(repoRoot, 'docs/generated/webhook-events.md')

describe('domain events doc (#139 / ADR-080 doc↔code linkage)', () => {
  it('every catalogued event has a non-empty description', () => {
    const entries = Object.entries(EVENT_CATALOG)
    expect(entries.length).toBeGreaterThan(20) // the bus is substantial — sanity floor
    for (const [type, desc] of entries) expect(desc, type).toBeTruthy()
  })

  it('render is deterministic and lists representative events', () => {
    const a = renderEventsMarkdown(EGRESS)
    expect(a).toBe(renderEventsMarkdown(EGRESS))
    for (const t of ['page.created', 'member.added', 'scim_token.created', 'tenant.plan_changed']) {
      expect(a).toContain(`\`${t}\``)
    }
    expect(a).toContain('AUTO-GENERATED')
    // ⚠️ And it says what each one sends. A page that answers "Yes" for everything is what a caller
    // with no verdicts produces, and it was committed for exactly as long as this check did not exist.
    expect(a, 'an event ruled out of egress is marked as such').toContain('| `auth.success` |')
    expect(a.split('\n').find((l) => l.startsWith('| `auth.success` |')), 'auth.success is not sent').toMatch(/\| No \|$/)
    expect(a.split('\n').find((l) => l.startsWith('| `member.locked` |')), 'and a redacted one names the field').toMatch(/without `identifier`/)
  })

  it('committed generated doc is NOT stale (CI stale-guard)', () => {
    expect(readFileSync(generatedPath, 'utf8')).toBe(renderEventsMarkdown(EGRESS))
  })
})
