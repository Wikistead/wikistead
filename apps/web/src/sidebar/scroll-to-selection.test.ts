// #899 / #736 / #274: when the sidebar scrolls the open row into view, and when it must not.
//
// ⚠️ These three tickets are one rule pulling in two directions, which is why it needs a pin that
// drives a SEQUENCE rather than a state. #274 wants the row brought into view when it arrives.
// #736 wants a scrolling reader left alone while `more:` loads. #899 is the case where those two
// were told apart by a fact that is not stable: "have we scrolled for this selection", which cannot
// see a row that left and came back.
import { describe, it, expect } from 'vitest'
import { decideScroll, mergePaintedWindow, mergeReachedWindow, visibleBranchPages, NO_SCROLL_YET, type ScrollMemory } from './scroll-to-selection'

/** Drive a sequence and return which steps scrolled — the shape all three tickets are about. */
const run = (steps: readonly { id: string | null; here: boolean }[]): boolean[] => {
  let memory: ScrollMemory = NO_SCROLL_YET
  const scrolled: boolean[] = []
  for (const s of steps) {
    const d = decideScroll(memory, s.id, s.here)
    memory = d.next
    scrolled.push(d.scroll)
  }
  return scrolled
}

describe('#899 the sidebar scrolls to the open row', () => {
  it('scrolls when a selection arrives', () => {
    expect(run([{ id: 'p1', here: true }])).toEqual([true])
  })

  it('#274: waits for a row that is not in the tree yet, then scrolls when it arrives', () => {
    // A page created a moment ago: the navigation lands before the refetch that draws its row.
    expect(run([{ id: 'p1', here: false }, { id: 'p1', here: true }])).toEqual([false, true])
  })

  it('#736: paging does NOT pull a scrolling reader back', () => {
    // `more:` appends and hands the tree a new array. The row never left, so nothing moves.
    expect(run([
      { id: 'p1', here: true },
      { id: 'p1', here: true },
      { id: 'p1', here: true },
    ])).toEqual([true, false, false])
  })

  it('⚠️ #899: a row that disappears and returns is scrolled to again', () => {
    // THE REPORTED CASE. Reader has scrolled three windows down and clicks a row there. Opening it
    // changes the paint's query key, the paint reseeds that branch with its FIRST window, and the row
    // goes. The reach then fetches the row's path and replaces the window again, so it comes back —
    // somewhere else. Without the third state this returns [true, false, false] and the row is left
    // off-screen, which is exactly what the reader reported.
    expect(run([
      { id: 'p1', here: true },   // clicked; row is in the loaded window
      { id: 'p1', here: false },  // paint reseeds the branch — row gone
      { id: 'p1', here: true },   // reach replaces the window — row back, elsewhere
    ])).toEqual([true, false, true])
  })

  it('⚠️ …and it does not scroll again once it has settled', () => {
    // The flicker is two frames, not a loop: after the row returns and is scrolled to, further tree
    // churn (paging on another branch, a placeholder resolving) must leave the viewport alone.
    expect(run([
      { id: 'p1', here: true },
      { id: 'p1', here: false },
      { id: 'p1', here: true },
      { id: 'p1', here: true },
      { id: 'p1', here: true },
    ])).toEqual([true, false, true, false, false])
  })

  it('a new selection scrolls even if the previous one never left', () => {
    expect(run([{ id: 'p1', here: true }, { id: 'p2', here: true }])).toEqual([true, true])
  })

  it('losing the selection forgets everything, so returning to the same page scrolls', () => {
    // Navigating away and back is two events, not one continuation.
    expect(run([
      { id: 'p1', here: true },
      { id: null, here: false },
      { id: 'p1', here: true },
    ])).toEqual([true, false, true])
  })
})

describe('#899 a repaint keeps what the reader loaded past its window', () => {
  const w = (ids: string[], cursor: string | null = null) => ({ pages: ids.map((id) => ({ id })), nextCursor: cursor })

  it('keeps the tail, and takes the cursor that points past it', () => {
    // The reader loaded three windows; the paint returns the first. Without this the rows they were
    // looking at vanish on every navigation — and the row they just clicked goes with them.
    const existing = w(['a', 'b', 'c', 'd', 'e', 'f'], 'cur-after-f')
    const fresh = w(['a', 'b', 'c'], 'cur-after-c')
    const out = mergePaintedWindow(existing, fresh)
    expect(out.pages.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(out.nextCursor, 'the fresh cursor would re-fetch rows already on screen').toBe('cur-after-f')
  })

  it('⚠️ the fresh window is authoritative for what it covers', () => {
    // A rename or a reorder inside the first window has to land: the tail is kept, the head is not.
    // ⚠️ Both windows carry a cursor: without one on the fresh side the branch is fully covered and
    // there is no tail by definition — which the case below measures.
    const out = mergePaintedWindow(w(['a', 'b', 'c', 'd'], 'cur-d'), w(['a', 'x', 'c'], 'cur-c'))
    expect(out.pages.map((p) => p.id)).toEqual(['a', 'x', 'c', 'd'])
  })

  it('⚠️ takes the fresh answer whole when the tail cannot be positioned', () => {
    // The fresh window's last row is not in what the reader holds — the branch moved by more than an
    // edit. Splicing at a guessed offset would draw two runs as if they were adjacent.
    const out = mergePaintedWindow(w(['a', 'b', 'c', 'd'], 'cur-d'), w(['x', 'y', 'z'], 'cur-z'))
    expect(out.pages.map((p) => p.id)).toEqual(['x', 'y', 'z'])
  })

  it('takes the fresh answer when the reader has loaded nothing more', () => {
    expect(mergePaintedWindow(undefined, w(['a', 'b'])).pages.map((p) => p.id)).toEqual(['a', 'b'])
    expect(mergePaintedWindow(w(['a', 'b']), w(['a', 'b'])).pages.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('⚠️ a fresh window with no cursor covers the whole branch, so no tail is kept', () => {
    // THE CASE THAT CAUGHT ITSELF while this pin was being written. A shortened window ends earlier,
    // so the join finds its end further up the reader's copy and splices the deleted rows back in.
    // No cursor means the branch is fully covered: the fresh answer is the whole answer.
    const out = mergePaintedWindow(w(['a', 'b', 'c', 'd', 'e'], 'cur'), w(['a', 'b'], null))
    expect(out.pages.map((p) => p.id), 'a deleted row came back through the join').toEqual(['a', 'b'])
  })

  it('…and a shortened window that DOES have a cursor still keeps its tail', () => {
    // The branch has more rows; this window simply ended where it ended. The tail is still the
    // reader's, and the rows between are the ones the fresh window is authoritative about.
    const out = mergePaintedWindow(w(['a', 'b', 'c', 'd', 'e'], 'cur-e'), w(['a', 'b'], 'cur-b'))
    expect(out.pages.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('#899 reload keeps the first and reached windows distinct', () => {
  const w = (ids: string[], cursor: string | null = null) => ({ pages: ids.map((id) => ({ id })), nextCursor: cursor })

  it('keeps the first window and its paging cursor when reach finds a distant target', () => {
    const painted = mergePaintedWindow(undefined, w(['a', 'b', 'c'], 'after-c'))
    const reached = mergeReachedWindow(painted, w(['x', 'selected', 'z'], 'after-z'))

    expect(visibleBranchPages(reached).map((page) => page.id)).toEqual(['a', 'b', 'c', 'x', 'selected', 'z'])
    expect(reached.nextCursor, 'paging must still fill the gap after the first window').toBe('after-c')
    expect(reached.reachedWindow?.nextCursor).toBe('after-z')
  })

  it('de-duplicates a reached window as ordinary paging catches up to it', () => {
    const reached = mergeReachedWindow(w(['a', 'b', 'c', 'x'], 'after-x'), w(['x', 'selected', 'z'], 'after-z'))
    expect(visibleBranchPages(reached).map((page) => page.id)).toEqual(['a', 'b', 'c', 'x', 'selected', 'z'])
  })

  it('keeps the reached window when the first window repaints', () => {
    const reached = mergeReachedWindow(w(['a', 'b', 'c'], 'after-c'), w(['x', 'selected', 'z'], 'after-z'))
    const repainted = mergePaintedWindow(reached, w(['a', 'b', 'c'], 'after-c'))
    expect(visibleBranchPages(repainted).map((page) => page.id)).toEqual(['a', 'b', 'c', 'x', 'selected', 'z'])
  })

  it('does not add a reached window when the selected page is already held', () => {
    const first = w(['a', 'selected', 'c'], 'after-c')
    expect(mergeReachedWindow(first, w(['selected'], 'after-selected'))).toBe(first)
  })
})
