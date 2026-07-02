// #120 / ADR-040 (option 2) — the tombstone-compaction DECISION core (PURE, real Yjs, no DB). Repeated
// restore cycles (delete-all + insert) accumulate STRUCTURAL delete tombstones; compactIfBloated
// re-encodes a fresh doc from the current 'content' text when — and only when — the stored state is
// bloated, preserving the content EXACTLY. Verified with distinct real Yjs states, not byte guesses:
// a bloated doc shrinks + round-trips; a small doc and a large-but-not-bloated doc are left as-is.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { compactIfBloated } from '../ydoc.js'

const contentOf = (state: Uint8Array): string => {
  const d = new Y.Doc()
  Y.applyUpdate(d, state)
  const s = d.getText('content').toString()
  d.destroy()
  return s
}

// A doc whose 'content' was cleared + rewritten `cycles` times (each cycle tombstones the previous
// text — the append-only restore pattern), leaving `final` as the live text. Built with gc:false so
// the deletion STRUCTURE actually accumulates (the worst case a peer can persist — heavy interleaved
// multi-client deletes, or a client run without gc); a plain gc:true doc coalesces the delete-all+
// insert pattern back to ~content size, which is exactly why compaction is a rare safety valve.
function bloated(base: string, cycles: number): { state: Uint8Array; final: string } {
  const doc = new Y.Doc({ gc: false })
  const t = doc.getText('content')
  let final = base
  t.insert(0, base)
  for (let i = 0; i < cycles; i++) {
    t.delete(0, t.length)
    final = `${base} rev${i}`
    t.insert(0, final)
  }
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return { state, final }
}

describe('compactIfBloated (ADR-040 #120)', () => {
  it('a bloated doc (many restore cycles) is re-encoded smaller with the content preserved exactly', () => {
    const { state, final } = bloated('X'.repeat(2000), 200) // ~200 tombstoned 2KB revisions (gc:false)
    expect(state.length).toBeGreaterThan(128 * 1024) // over the compaction floor
    const compacted = compactIfBloated(state)
    expect(compacted).not.toBeNull()
    expect(compacted!.length).toBeLessThan(state.length) // tombstones dropped
    expect(contentOf(compacted!)).toBe(final) // round-trip: the LIVE text is identical
  })

  it('a small doc is left as-is (null) — no needless rewrite below the size floor', () => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'a short page body')
    const state = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    expect(state.length).toBeLessThan(128 * 1024)
    expect(compactIfBloated(state)).toBeNull() // below floor → not compacted
  })

  it('a large but low-tombstone doc is left as-is (re-encode would not shrink it enough)', () => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'Z'.repeat(200 * 1024)) // large CONTENT, no delete history
    const state = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    expect(state.length).toBeGreaterThan(128 * 1024)
    expect(compactIfBloated(state)).toBeNull() // nothing to reclaim → leave it (no churn)
  })
})
