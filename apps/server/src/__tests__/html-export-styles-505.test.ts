// #505 / #207 (ADR-191): the acceptance is that NO rendered element breaks in print, and print now comes
// from this export document. Audited the canonical HTML against its own stylesheet and found :::todo
// emitted a bare <div> — the accent box the editor draws was missing, so a checklist container lost its
// shape on paper. (mermaid degrades to source but inherits the shared <pre> box, and math is MathML which
// needs no stylesheet — both verified, neither is a gap.)
//
// This pins the stylesheet CONTRACT: every class the renderer emits for a container has a rule, so a new
// container cannot ship invisible. It reads the real EXPORT_STYLES rather than a copy.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderMarkdownToHtml, builtinMacroRegistry } from '@wikistead/macro-render'

const source = readFileSync(new URL('../render/html-export.ts', import.meta.url), 'utf8')

describe('#505: the export stylesheet covers what the renderer emits', () => {
  it('styles the :::todo container box', () => {
    const out = renderMarkdownToHtml(':::todo\n- [ ] a\n:::', builtinMacroRegistry()).toString()
    expect(out, 'the renderer emits .todo').toContain('class="todo"')
    expect(source, 'and the export stylesheet has a rule for it').toMatch(/\.todo\s*\{/)
    expect(source, 'with the accent box the editor draws').toMatch(/\.todo\{[^}]*border-left/)
  })

  it('styles the static checklist so it does not keep a bullet next to the box', () => {
    expect(source).toMatch(/input\[type=checkbox\]/)
  })

  it('every container class the renderer emits has a stylesheet rule', () => {
    const md = [':::note[N]', 'b', ':::', '', '::::columns', ':::column', 'l', ':::', '::::', '', ':::todo', '- [ ] a', ':::'].join('\n')
    const out = renderMarkdownToHtml(md, builtinMacroRegistry()).toString()
    const classes = [...new Set([...out.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)))]
    const unstyled = classes.filter((c) => !new RegExp(`\\.${c}\\b`).test(source))
    expect(unstyled, `these classes render with no export CSS: ${unstyled.join(', ')}`).toEqual([])
  })
})
