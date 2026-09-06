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
 * So the state records both presence and structural position. A row that disappears and returns, or
 * stays present while a gap window is inserted before it, may need alignment again. Appending after
 * the row leaves its position unchanged and therefore preserves #736's manual-scroll guarantee.
 */
export type ScrollMemory = {
  selection: string | null;
  rowWasPresent: boolean;
  rowPosition: string | null;
};

export const NO_SCROLL_YET: ScrollMemory = { selection: null, rowWasPresent: false, rowPosition: null };

export type ScrollDecision = { scroll: boolean; next: ScrollMemory };

export type SelectionAlignment = {
  scroll: () => void | Promise<void>;
  afterLayout: () => Promise<void>;
  isVisible: () => boolean;
  isCancelled?: () => boolean;
};

/** Retry across tree reconstruction; a scroll request is not evidence that its row became visible. */
export async function alignSelectedRow(
  alignment: SelectionAlignment,
  attempts = 4,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (alignment.isCancelled?.()) return false;
    await alignment.scroll();
    await alignment.afterLayout();
    if (alignment.isCancelled?.()) return false;
    if (alignment.isVisible()) return true;
  }
  return false;
}

/**
 * ⚠️ Pure, and deliberately so. The rule is what breaks here, and a rule that only exists inside an
 * effect can be measured only by rendering — which is how this one went four months without a pin.
 */
export function decideScroll(
  memory: ScrollMemory,
  selectedId: string | null,
  rowExists: boolean,
  rowPosition = rowExists ? "present" : null,
  realignMovedRow = true,
): ScrollDecision {
  // No selection: forget everything. The next selection is a fresh event.
  if (!selectedId) return { scroll: false, next: NO_SCROLL_YET };

  // The row is not in the tree — a page just created, a branch still loading, or (the #899 case) a
  // window the paint has just replaced. ⚠️ Record the absence: it is what makes the row's return an
  // appearance rather than a continuation.
  if (!rowExists) {
    return { scroll: false, next: { selection: selectedId, rowWasPresent: false, rowPosition: null } };
  }

  // The row is here at the position already aligned. This includes paging appended after it, so
  // #736's whole point survives: that ordinary change must not move the reader's viewport.
  if (memory.selection === selectedId && memory.rowWasPresent && memory.rowPosition === rowPosition) {
    return { scroll: false, next: memory };
  }
  if (memory.selection === selectedId && memory.rowWasPresent && !realignMovedRow) {
    return { scroll: false, next: { ...memory, rowPosition } };
  }

  // The selection changed, the row appeared, or an insertion before it changed its structural path.
  // Scroll, and remember both its presence and the position that was aligned.
  return { scroll: true, next: { selection: selectedId, rowWasPresent: true, rowPosition } };
}

/** One branch window as the sidebar caches it. Only the fields this merge reasons about. */
export type BranchWindow = {
  pages: readonly { id: string }[];
  nextCursor?: string | null;
  reachedWindow?: BranchWindow;
  /** #1149 rev2: client-side bookkeeping (see `lazy-tree.ts`'s `BranchAnswer`) — carried through a
   * tail-preserving merge (the reader's accumulated scroll position is still the authoritative view),
   * dropped when a fresh single fetch supersedes it wholesale (see `mergePaintedWindow` below). */
  pagedPastFirstWindow?: boolean;
};

/** Keep a non-adjacent target window without pretending it follows the first window. */
export function mergeReachedWindow<T extends BranchWindow>(existing: T | undefined, reached: T): T & { reachedWindow?: T } {
  if (!existing) return reached as T & { reachedWindow?: T };
  const held = new Set(existing.pages.map((page) => page.id));
  if (reached.pages.every((page) => held.has(page.id))) return existing as T & { reachedWindow?: T };
  return { ...existing, reachedWindow: reached };
}

/** Rows held by a branch, with a reached window de-duplicated behind the primary run. */
export function visibleBranchPages<T extends BranchWindow>(branch: T): T["pages"] {
  if (!branch.reachedWindow) return branch.pages;
  const held = new Set(branch.pages.map((page) => page.id));
  return [...branch.pages, ...branch.reachedWindow.pages.filter((page) => !held.has(page.id))] as T["pages"];
}

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
  if (!existing) return fresh;
  // ⚠️ A fresh window with no cursor covers the WHOLE branch, so there is no tail to keep — and
  // keeping one would resurrect rows the branch no longer has. Measured while writing the pin: a
  // deleted row came back through the join, because the join asks where the fresh window ENDS and a
  // shortened window ends earlier.
  if (fresh.nextCursor == null) return fresh;
  if (existing.pages.length <= fresh.pages.length) {
    return { ...fresh, reachedWindow: existing.reachedWindow, pagedPastFirstWindow: existing.pagedPastFirstWindow } as T;
  }
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
  // #1149 rev2: `pagedPastFirstWindow` carries the same way — the reader's accumulated, still-unfinished
  // multi-fetch view is what this branch represents, not the fresh single window alone.
  return {
    ...fresh,
    pages: [...fresh.pages, ...tail],
    nextCursor: existing.nextCursor,
    reachedWindow: existing.reachedWindow,
    pagedPastFirstWindow: existing.pagedPastFirstWindow,
  } as T;
}
