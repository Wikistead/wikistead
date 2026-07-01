// ADR-088 / #186 — the empty-overwrite guard's DECISION core (PURE, real Yjs, no DB). A page is only
// wiped by an EMPTY incoming state; the danger is telling apart a LEGITIMATE clear (a loaded doc that
// deleted everything) from an UNLOADED flush (a fresh doc that never saw the content). Verified with
// BOTH — reject the wipe AND allow the clear (positive control, per the ADR/review) — using distinct
// real Yjs states, not byte lengths.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { isUnloadedEmptyFlush } from '../ydoc.js'

// A doc whose 'content' Y.Text holds `text`, encoded as a full state update.
function stateWith(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

// A LOADED writer that observed `existingState` and then deleted everything (a real select-all-delete).
function clearedFrom(existingState: Uint8Array): Uint8Array {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, existingState) // the writer LOADED the existing content …
  const t = doc.getText('content')
  t.delete(0, t.length) // … then cleared it
  return Y.encodeStateAsUpdate(doc)
}

// A FRESH writer that never loaded anything (init race / empty-encode bug / new doc autosaving).
function freshEmpty(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc())
}

describe('isUnloadedEmptyFlush (ADR-088 #186)', () => {
  const existing = stateWith('important page body')

  it('REJECTS an unloaded empty flush over a non-empty page (would silently wipe → block)', () => {
    expect(isUnloadedEmptyFlush(existing, freshEmpty())).toBe(true)
  })

  it('ALLOWS a legitimate clear from a doc that OBSERVED the content (real select-all-delete)', () => {
    // positive control: a genuine clear must NOT be blocked (offset causality, not byte length)
    expect(isUnloadedEmptyFlush(existing, clearedFrom(existing))).toBe(false)
  })

  it('ALLOWS an empty write over an already-empty page (nothing to lose)', () => {
    expect(isUnloadedEmptyFlush(stateWith(''), freshEmpty())).toBe(false)
  })

  it('ALLOWS a non-empty incoming write (not a wipe at all)', () => {
    expect(isUnloadedEmptyFlush(existing, stateWith('new body'))).toBe(false)
    // even a fresh (unobserved) NON-empty write is allowed — the guard only blocks EMPTY flushes
    expect(isUnloadedEmptyFlush(existing, stateWith('unrelated fresh doc'))).toBe(false)
  })

  it('REJECTS an unloaded flush even when the fresh doc has a (deleted) history of its own', () => {
    // a fresh doc that typed then deleted its OWN text is still empty AND never saw `existing` → block
    const d = new Y.Doc(); const t = d.getText('content'); t.insert(0, 'x'); t.delete(0, 1)
    expect(isUnloadedEmptyFlush(existing, Y.encodeStateAsUpdate(d))).toBe(true)
  })
})
