// #308 / ADR-132: pure unit tests for the import archive parser (streaming unzip + size caps) and the IR
// builder (tree reconstruction from dir nesting + manifest). No infra — fflate builds the fixtures.
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8, strFromU8 } from 'fflate'
import { streamingUnzip, buildIR, ImportTooLargeError } from '../import/index.js'

describe('streamingUnzip (#308 zip-bomb defense)', () => {
  it('round-trips a normal archive (correctness parity with the writer)', () => {
    const zip = zipSync({ 'a/index.md': strToU8('# A'), 'a/images/x.png': new Uint8Array([1, 2, 3]) })
    const out = streamingUnzip(zip)
    expect(strFromU8(out['a/index.md']!)).toBe('# A')
    expect([...out['a/images/x.png']!]).toEqual([1, 2, 3])
  })

  it('aborts when a single entry inflates past the per-entry cap', () => {
    const zip = zipSync({ 'big.md': strToU8('x'.repeat(10_000)) })
    expect(() => streamingUnzip(zip, { maxTotalBytes: 1e9, maxEntryBytes: 100, maxEntries: 10 })).toThrow(ImportTooLargeError)
  })

  it('aborts when the running total inflates past the total cap (mid-inflation, not after)', () => {
    const zip = zipSync({ 'a.md': strToU8('x'.repeat(4000)), 'b.md': strToU8('y'.repeat(4000)) })
    expect(() => streamingUnzip(zip, { maxTotalBytes: 5000, maxEntryBytes: 1e9, maxEntries: 10 })).toThrow(ImportTooLargeError)
  })

  it('aborts when there are too many entries', () => {
    const many: Record<string, Uint8Array> = {}
    for (let i = 0; i < 20; i++) many[`f${i}.md`] = strToU8('x')
    expect(() => streamingUnzip(zipSync(many), { maxTotalBytes: 1e9, maxEntryBytes: 1e9, maxEntries: 5 })).toThrow(ImportTooLargeError)
  })
})

describe('buildIR (#308 tree reconstruction)', () => {
  const manifest = JSON.stringify({
    formatVersion: 1,
    pages: [
      { oldId: 'p1', dir: 'Root', title: 'Root Page', published: true },
      { oldId: 'p2', dir: 'Root/Child', title: 'Child Page', published: true },
      { oldId: 'p3', dir: 'Empty', title: 'Empty Draft', published: false },
    ],
  })

  it('reconstructs the tree from dir nesting and reads titles + oldId + published from the manifest', () => {
    const files = {
      'manifest.json': strToU8(manifest),
      'Root/index.md': strToU8('# Root\n\n[child](/p/p2)'),
      'Root/Child/index.md': strToU8('## Child'),
      'Root/images/logo.png': new Uint8Array([9]),
      'Empty/index.md': strToU8(''),
    }
    const ir = buildIR(files)
    expect(ir.hasManifest).toBe(true)
    // Root + Empty are roots; Child nests under Root (dir prefix).
    const roots = ir.roots.map((r) => r.title).sort()
    expect(roots).toEqual(['Empty Draft', 'Root Page'])
    const root = ir.roots.find((r) => r.title === 'Root Page')!
    expect(root.oldId).toBe('p1')
    expect(root.children.map((c) => c.title)).toEqual(['Child Page'])
    expect(root.attachments.map((a) => a.relPath)).toEqual(['images/logo.png'])
    // the empty unpublished node is marked not-published (→ materializes as an empty draft)
    expect(ir.roots.find((r) => r.title === 'Empty Draft')!.published).toBe(false)
  })

  it('falls back to dir-name titles + best-effort (no oldId) when there is no manifest', () => {
    const ir = buildIR({ 'My Notes/index.md': strToU8('# hi'), 'My Notes/Sub/index.md': strToU8('## s') })
    expect(ir.hasManifest).toBe(false)
    expect(ir.roots.map((r) => r.title)).toEqual(['My Notes'])
    expect(ir.roots[0]!.oldId).toBeNull()
    expect(ir.roots[0]!.children[0]!.title).toBe('Sub')
    // published inferred from body presence when there's no manifest
    expect(ir.roots[0]!.published).toBe(true)
  })

  it('space-prefixed dirs (tenant export) whose prefix is not a page become import roots', () => {
    // "Space" has no index.md → not a page; its pages attach as roots (imported into the chosen destination).
    const ir = buildIR({ 'Space/Page A/index.md': strToU8('a'), 'Space/Page B/index.md': strToU8('b') })
    expect(ir.roots.map((r) => r.title).sort()).toEqual(['Page A', 'Page B'])
  })
})

describe('buildIR (#501 bare .md files)', () => {
  it('a ZIP of loose .md files imports — each bare file is its own single-page dir', () => {
    const ir = buildIR({ 'notes.md': strToU8('# my notes'), 'ideas.md': strToU8('later') })
    expect(ir.roots.map((r) => r.dir).sort()).toEqual(['ideas', 'notes'])
    const notes = ir.roots.find((r) => r.dir === 'notes')!
    expect(notes.title).toBe('notes')
    expect(notes.markdown).toBe('# my notes')
    expect(notes.published).toBe(true)
  })

  it('index.md outranks a sibling bare <dir>.md — one page, the index body wins', () => {
    const ir = buildIR({ 'guide.md': strToU8('BARE'), 'guide/index.md': strToU8('INDEX') })
    expect(ir.roots).toHaveLength(1)
    expect(ir.roots[0]!.dir).toBe('guide')
    expect(ir.roots[0]!.markdown).toBe('INDEX')
  })

  it('a nested bare .md nests under its enclosing page dir (mixed archives keep the tree)', () => {
    const ir = buildIR({ 'guide/index.md': strToU8('parent'), 'guide/extra.md': strToU8('leaf') })
    expect(ir.roots).toHaveLength(1)
    expect(ir.roots[0]!.children.map((c) => c.dir)).toEqual(['guide/extra'])
  })

  it('a .md inside an attachment folder stays an attachment (never a page); root _home.md stays the home', () => {
    const ir = buildIR({ 'a/index.md': strToU8('x'), 'a/images/note.md': strToU8('att'), '_home.md': strToU8('home') })
    expect(ir.roots.map((r) => r.dir).sort()).toEqual(['_home', 'a'])
    const a = ir.roots.find((r) => r.dir === 'a')!
    expect(a.attachments.map((t) => t.name)).toEqual(['note.md'])
    expect(ir.roots.find((r) => r.dir === '_home')!.isHome).toBe(true)
  })

  it('an unpublished-looking bare file (empty body) imports as a draft, like an empty index.md', () => {
    const ir = buildIR({ 'todo.md': strToU8('   ') })
    expect(ir.roots).toHaveLength(1)
    expect(ir.roots[0]!.published).toBe(false)
  })
})
