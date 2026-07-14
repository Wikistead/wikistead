// #369 / ADR-144: the pure body-edit planner (append / replace_section → one offset-invariant Y.Text edit).
// A wrong offset here would corrupt the canonical doc, so pin the exact {from, deleteCount, insert} and verify
// applying the plan to the string yields the intended markdown (the collab handler runs delete+insert at `from`).
import { describe, it, expect } from 'vitest'
import { planBodyEdit, EditApplyError, parseMcpEditRequest, type EditOp } from '../mcp-edit-apply.js'

// Apply a plan the way the collab handler does: delete `deleteCount` chars at `from`, then insert.
const apply = (text: string, op: EditOp) => {
  const p = planBodyEdit(text, op)
  expect(p.from).toBeGreaterThanOrEqual(0)
  expect(p.from + p.deleteCount).toBeLessThanOrEqual(text.length)
  return text.slice(0, p.from) + p.insert + text.slice(p.from + p.deleteCount)
}

describe('planBodyEdit — append', () => {
  it('appends a block separated by a blank line', () => {
    expect(apply('# Title\n\nHello', { op: 'append', content: 'A new paragraph.' }))
      .toBe('# Title\n\nHello\n\nA new paragraph.')
  })
  it('into an EMPTY doc inserts the content with no leading newlines', () => {
    expect(apply('', { op: 'append', content: '# First\n\nbody' })).toBe('# First\n\nbody')
  })
  it('collapses trailing whitespace so it never accumulates blank lines', () => {
    expect(apply('body\n\n\n', { op: 'append', content: 'more' })).toBe('body\n\nmore')
  })
  it('rejects empty content', () => {
    expect(() => planBodyEdit('x', { op: 'append', content: '   ' })).toThrow(EditApplyError)
  })
})

describe('planBodyEdit — replace_section', () => {
  const doc = [
    '# Top',
    '',
    'intro',
    '',
    '## Getting Started',
    '',
    'old body',
    '',
    '### Sub',
    '',
    'sub body',
    '',
    '## Next',
    '',
    'next body',
  ].join('\n')

  it('replaces a section up to the next SAME-level heading (a deeper sub-heading stays part of it)', () => {
    const out = apply(doc, { op: 'replace_section', heading: 'Getting Started', content: '## Getting Started\n\nfresh body' })
    expect(out).toContain('## Getting Started\n\nfresh body')
    expect(out).not.toContain('old body')
    expect(out).not.toContain('### Sub') // the sub-section was part of Getting Started → replaced
    expect(out).toContain('## Next\n\nnext body') // the next same-level section is untouched
    expect(out).toContain('# Top\n\nintro') // content above is untouched
  })

  it('replaces the LAST section (runs to EOF)', () => {
    const out = apply(doc, { op: 'replace_section', heading: 'Next', content: '## Next\n\nrewritten' })
    expect(out).toContain('## Next\n\nrewritten')
    expect(out).not.toContain('next body')
    expect(out.endsWith('rewritten')).toBe(true)
  })

  it('matches the heading case-insensitively and whitespace-normalised', () => {
    const out = apply(doc, { op: 'replace_section', heading: '  getting   started ', content: '## Getting Started\n\nx' })
    expect(out).toContain('## Getting Started\n\nx')
    expect(out).not.toContain('old body')
  })

  it('does not fuse into the following heading (keeps a blank line before the next section)', () => {
    const out = apply(doc, { op: 'replace_section', heading: 'Getting Started', content: '## Getting Started\n\nfresh' })
    expect(out).toContain('fresh\n\n## Next')
  })

  it('throws EditApplyError when the heading is not found (never a silent no-op)', () => {
    expect(() => planBodyEdit(doc, { op: 'replace_section', heading: 'Nonexistent', content: 'x' })).toThrow(/section not found/)
  })

  it('rejects empty heading or content', () => {
    expect(() => planBodyEdit(doc, { op: 'replace_section', heading: '', content: 'x' })).toThrow(EditApplyError)
    expect(() => planBodyEdit(doc, { op: 'replace_section', heading: 'Top', content: '  ' })).toThrow(EditApplyError)
  })

  it('placeholder', () => { expect(true).toBe(true) })
})

describe('parseMcpEditRequest — wire validation (the pod NEVER applies a half-understood request)', () => {
  const base = { reqId: 'r1', tenant: 't1', user: 'user:alice', op: 'append', content: 'hi', sizeCap: 1000 }
  const raw = (o: object) => JSON.stringify({ ...base, ...o })

  it('parses a valid append request', () => {
    expect(parseMcpEditRequest(raw({}))).toEqual({ reqId: 'r1', tenant: 't1', user: 'user:alice', op: { op: 'append', content: 'hi' }, sizeCap: 1000 })
  })
  it('parses a valid replace_section request (heading carried into the op)', () => {
    const r = parseMcpEditRequest(raw({ op: 'replace_section', heading: 'Intro' }))
    expect(r.op).toEqual({ op: 'replace_section', heading: 'Intro', content: 'hi' })
  })
  it('rejects a replace_section with no heading', () => {
    expect(() => parseMcpEditRequest(raw({ op: 'replace_section' }))).toThrow(/heading is required/)
  })
  it('rejects an unknown op', () => {
    expect(() => parseMcpEditRequest(raw({ op: 'delete_everything' }))).toThrow(/unknown op/)
  })
  it('rejects a user that is not a user:<sub> principal (no share_link / anon body writes)', () => {
    expect(() => parseMcpEditRequest(raw({ user: 'share_link:x' }))).toThrow(/missing user/)
  })
  it('enforces the size cap (content longer than sizeCap is refused before touching the doc)', () => {
    expect(() => parseMcpEditRequest(raw({ content: 'x'.repeat(11), sizeCap: 10 }))).toThrow(/exceeds size limit/)
  })
  it('rejects malformed JSON and missing fields', () => {
    expect(() => parseMcpEditRequest('not json')).toThrow(/malformed/)
    expect(() => parseMcpEditRequest(raw({ reqId: '' }))).toThrow(/missing reqId/)
    expect(() => parseMcpEditRequest(raw({ tenant: '' }))).toThrow(/missing tenant/)
  })
})

describe('planBodyEdit — H1 section spans everything below', () => {
  const doc = ['# Top', '', 'intro', '', '## Getting Started', '', 'old body', '', '### Sub', '', 'sub body', '', '## Next', '', 'next body'].join('\n')
  const apply = (text: string, op: EditOp) => { const p = planBodyEdit(text, op); return text.slice(0, p.from) + p.insert + text.slice(p.from + p.deleteCount) }
  it('replacing an H1 section spans every lower-level heading beneath it (up to the next H1 / EOF)', () => {
    // An H2/H3 is level > 1, so it is PART of the H1 section — replacing the sole H1 "Top" rewrites the whole
    // document below it. This is the consistent section model (a section owns its sub-headings); a caller who
    // wants to keep sub-sections targets them individually. It is NOT the forbidden "full-body replace" op — it
    // is an explicit, named-section edit that happens to be the outermost section.
    const out = apply(doc, { op: 'replace_section', heading: 'Top', content: '# Top\n\nnew intro' })
    expect(out).toBe('# Top\n\nnew intro')
  })
})
