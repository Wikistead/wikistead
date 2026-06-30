// Server macro level-cap detection (#93 / ADR-073). Pure: a ::: directive opener exceeds any cap
// below 'directive'; 'directive' (the default) never exceeds; plain Markdown is fine. Sound subset
// (no false positives) — the gfm-vs-commonmark table refinement is deferred.
import { describe, it, expect } from 'vitest'
import { markdownExceedsLevelCap } from '../macro-level-cap.js'

describe('markdownExceedsLevelCap (#93 / ADR-073)', () => {
  it("cap 'directive' (default) never exceeds — inert", () => {
    expect(markdownExceedsLevelCap(':::note\nhi\n:::', 'directive')).toBe(false)
    expect(markdownExceedsLevelCap('# plain', 'directive')).toBe(false)
  })

  it('a ::: directive exceeds a cap below directive (gfm / commonmark)', () => {
    expect(markdownExceedsLevelCap(':::note\nhi\n:::', 'gfm')).toBe(true)
    expect(markdownExceedsLevelCap('text\n\n:::table\n...\n:::', 'commonmark')).toBe(true)
    expect(markdownExceedsLevelCap(':::columns', 'gfm')).toBe(true)
  })

  it('plain / gfm Markdown without directives does not exceed a gfm cap', () => {
    expect(markdownExceedsLevelCap('# h\n\n| a | b |\n|---|---|\n| 1 | 2 |', 'gfm')).toBe(false)
    expect(markdownExceedsLevelCap('just text with ::: inline not at line start', 'gfm')).toBe(false)
  })
})
