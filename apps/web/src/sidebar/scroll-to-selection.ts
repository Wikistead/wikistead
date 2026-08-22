/**
 * #899: when does the sidebar scroll the open page's row into view?
 *
 * ⚠️ THE DEFECT this answers. #736 stopped the tree pulling a scrolling reader back to the open page
 * on every `more:` load, by scrolling on the EVENT rather than on the tree's identity: the selection
 * changed, or the selected row appeared for the first time. It remembered "we have scrolled for this
 * selection" in a ref — and a row that DISAPPEARS and comes back is, to that ref, the same appearance.
 *
 * That sequence is not hypothetical; it is what every navigation does. The paint's query key carries
 * the open page (`lazy-tree.ts`), so opening a page refetches it, and the paint's `queryFn` seeds every
 * branch key with `setQueryData` — replacing whatever `loadMore` appended there. `paintTree`'s `one()`
 * asks `listBranch` with no cursor, so what it seeds is always the branch's FIRST window. A reader who
 * scrolled three windows down and clicked a row therefore watches it vanish; the reach in `lazy-tree.ts`
 * then fetches the row's path and replaces the window again, so it comes back somewhere else. That is
 * the flicker. And because the ref had already been stamped while the row was still there, the return
 * scrolls nothing — the row is present and off-screen, which is the report.
 *
 * So the state is three-valued rather than two: not scrolled, scrolled and the row is here, scrolled
 * and the row has GONE. Only the last one may scroll again for the same selection.
 */
export type ScrollMemory = { selection: string | null; rowWasPresent: boolean };

export const NO_SCROLL_YET: ScrollMemory = { selection: null, rowWasPresent: false };

export type ScrollDecision = { scroll: boolean; next: ScrollMemory };

/**
 * ⚠️ Pure, and deliberately so. The rule is what breaks here, and a rule that only exists inside an
 * effect can be measured only by rendering — which is how this one went four months without a pin.
 */
export function decideScroll(
  memory: ScrollMemory,
  selectedId: string | null,
  rowExists: boolean,
): ScrollDecision {
  // No selection: forget everything. The next selection is a fresh event.
  if (!selectedId) return { scroll: false, next: NO_SCROLL_YET };

  // The row is not in the tree — a page just created, a branch still loading, or (the #899 case) a
  // window the paint has just replaced. ⚠️ Record the absence: it is what makes the row's return an
  // appearance rather than a continuation.
  if (!rowExists) return { scroll: false, next: { selection: selectedId, rowWasPresent: false } };

  // The row is here and we have already scrolled for it WHILE it was here: this is paging, or any
  // other change that leaves the row where it was. #736's whole point — do not move the viewport.
  if (memory.selection === selectedId && memory.rowWasPresent) {
    return { scroll: false, next: memory };
  }

  // Either the selection changed, or the row has just appeared — including reappearing after the
  // paint dropped it. Scroll, and remember that it is here.
  return { scroll: true, next: { selection: selectedId, rowWasPresent: true } };
}

/** One branch window as the sidebar caches it. Only the fields this merge reasons about. */
export type BranchWindow = {
  pages: readonly { id: string }[];
  nextCursor?: string | null;
};

/**
 * #899: fold a freshly painted FIRST window into whatever the reader has already loaded.
 *
 * ⚠️ THE DEFECT this answers. The paint's query key carries the open page, so every navigation
 * refetches it, and its `queryFn` seeds each branch key with `setQueryData` — **discarding** the
 * windows `loadMore` appended there. `paintTree`'s `one()` asks `listBranch` with no cursor, so the
 * seed is always the branch's first window: a reader three windows down loses the rows they were
 * looking at, every time they open a page. The reach then fetches the row's path and replaces the
 * window again, which is the second frame of the flicker.
 *
 * The fresh window is authoritative for what it covers — a rename or a deletion inside it must land.
 * What it must not do is speak for rows beyond its own end. ⚠️ **So the tail is kept only when the
 * fresh window's last row is still findable in what the reader holds**: that is the join, and without
 * it a deletion in the first window would splice the two runs at the wrong offset and draw rows that
 * are not adjacent as if they were.
 */
export function mergePaintedWindow<T extends BranchWindow>(existing: T | undefined, fresh: T): T {
  if (!existing || existing.pages.length <= fresh.pages.length) return fresh;
  // ⚠️ A fresh window with no cursor covers the WHOLE branch, so there is no tail to keep — and
  // keeping one would resurrect rows the branch no longer has. Measured while writing the pin: a
  // deleted row came back through the join, because the join asks where the fresh window ENDS and a
  // shortened window ends earlier.
  if (fresh.nextCursor == null) return fresh;
  const last = fresh.pages[fresh.pages.length - 1];
  if (!last) return fresh;
  const at = existing.pages.findIndex((p) => p.id === last.id);
  // The reader's copy does not contain the fresh window's end: the branch has changed under them by
  // more than an edit, and their tail cannot be positioned. Take the fresh answer whole.
  if (at < 0) return fresh;
  const tail = existing.pages.slice(at + 1);
  if (tail.length === 0) return fresh;
  // ⚠️ The cursor comes from the EXISTING entry: it points past the tail we are keeping, while the
  // fresh one points just past the first window and would re-fetch rows already on screen.
  return { ...fresh, pages: [...fresh.pages, ...tail], nextCursor: existing.nextCursor } as T;
}
