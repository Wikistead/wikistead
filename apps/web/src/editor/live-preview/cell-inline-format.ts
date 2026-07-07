import { safeHref } from "../macros/md-render"; // #89 comment 886 (②): the ONLY scheme judge for a cell link

// #89 (rescoped, then comment 830): the inline-decoration toolbar for a table cell being edited. A cell is
// a contenteditable ISLAND with its OWN DOM selection (not CodeMirror's), and it is a WYSIWYG surface —
// pressing Bold must make the selection LOOK bold immediately (not insert literal `**`). So a mark WRAPS
// the DOM selection in the corresponding safe element (strong/em/s/code/a), built with createElement (never
// innerHTML — the ADR-037 / #89 XSS boundary). The cell's canonical Markdown round-trips via cellElToText
// (<strong> → `**…**`), and re-opening a cell shows the marks WYSIWYG via renderCellInline.

// Each mark is a factory for its wrapper element plus the DOM tag set that COUNTS as this mark
// (#236 toggle detection — the same aliases cellElToText serialises). `link` needs a URL, so it is
// NOT a plain wrapper — the toolbar routes it through the URL popover (applyCellLink).
type Mark = { id: string; label: string; el: () => HTMLElement; tags: readonly string[] };
export const CELL_MARKS: Mark[] = [
  { id: "bold", label: "B", el: () => document.createElement("strong"), tags: ["STRONG", "B"] },
  { id: "italic", label: "I", el: () => document.createElement("em"), tags: ["EM", "I"] },
  { id: "strike", label: "S", el: () => document.createElement("s"), tags: ["S", "DEL", "STRIKE"] },
  { id: "code", label: "</>", el: () => document.createElement("code"), tags: ["CODE"] },
];

// #236: is EVERY text character of `range` inside an element whose tag is in `tags` (within `root`)?
// BRs don't count against coverage (a line break carries no formatting). False when the range holds
// no text at all.
function rangeFullyMarked(root: HTMLElement, range: Range, tags: readonly string[]): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let sawText = false;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!range.intersectsNode(t)) continue;
    // Ignore zero-length boundary touches (intersectsNode is inclusive at edges).
    const r = document.createRange();
    r.selectNodeContents(t);
    if (r.compareBoundaryPoints(Range.END_TO_START, range) >= 0 || r.compareBoundaryPoints(Range.START_TO_END, range) <= 0) continue;
    if (!(t.nodeValue ?? "").length) continue;
    sawText = true;
    let marked = false;
    for (let p = t.parentElement; p && p !== root; p = p.parentElement) {
      if (tags.includes(p.tagName)) { marked = true; break; }
    }
    if (!marked) return false;
  }
  return sawText;
}

// Unwrap every `tags` element inside `root` (replace it with its children). Recursion-safe: the
// NodeList is materialised before mutating.
function unwrapTags(root: ParentNode, tags: readonly string[]): void {
  for (const el of Array.from(root.querySelectorAll(tags.map((t) => t.toLowerCase()).join(",")))) {
    el.replaceWith(...Array.from(el.childNodes));
  }
}

// #236: make the range's boundaries sit OUTSIDE any `tags` element by SPLITTING boundary elements.
// Without this, extractContents on a selection that starts/ends exactly at an element's content
// boundary leaves the original element as a shell around the re-insertion point, so the "removed"
// content lands back INSIDE the mark. Marker technique: insert empty text markers at the range
// edges (insertNode splits a Text container as needed), then, while a marker's parent is a tags
// element, move the siblings on the far side into a shallow clone beside it and hoist the marker
// out. Empty split shells are dropped later by mergeAdjacent. Returns the two markers; the caller
// re-ranges between them and removes them afterwards.
function isolateRangeFromTags(root: HTMLElement, range: Range, tags: readonly string[]): { startMarker: Text; endMarker: Text } {
  const startMarker = document.createTextNode("");
  const endMarker = document.createTextNode("");
  const rEnd = range.cloneRange();
  rEnd.collapse(false);
  rEnd.insertNode(endMarker);
  const rStart = range.cloneRange();
  rStart.collapse(true);
  rStart.insertNode(startMarker);
  // Hoist the START marker out of every tags ancestor: children BEFORE it move to a pre-clone.
  while (startMarker.parentElement && startMarker.parentElement !== root && tags.includes(startMarker.parentElement.tagName)) {
    const parent = startMarker.parentElement;
    const pre = parent.cloneNode(false) as HTMLElement;
    while (parent.firstChild && parent.firstChild !== startMarker) pre.appendChild(parent.firstChild);
    parent.parentNode!.insertBefore(pre, parent);
    parent.parentNode!.insertBefore(startMarker, parent);
  }
  // Hoist the END marker out: children AFTER it move to a post-clone.
  while (endMarker.parentElement && endMarker.parentElement !== root && tags.includes(endMarker.parentElement.tagName)) {
    const parent = endMarker.parentElement;
    const post = parent.cloneNode(false) as HTMLElement;
    while (endMarker.nextSibling) post.appendChild(endMarker.nextSibling);
    parent.parentNode!.insertBefore(post, parent.nextSibling);
    parent.parentNode!.insertBefore(endMarker, parent.nextSibling);
  }
  return { startMarker, endMarker };
}

// Merge ADJACENT same-tag siblings and drop empty ones, so an apply next to an existing mark can't
// serialise to the ambiguous `**ab****cd**` form.
function mergeAdjacent(root: HTMLElement, tags: readonly string[]): void {
  for (const el of Array.from(root.querySelectorAll(tags.map((t) => t.toLowerCase()).join(",")))) {
    if (!el.isConnected) continue;
    if (!(el.textContent ?? "").length) { el.remove(); continue; }
    let next = el.nextSibling;
    while (next instanceof HTMLElement && next.tagName === el.tagName) {
      el.append(...Array.from(next.childNodes));
      const gone = next;
      next = gone.nextSibling;
      gone.remove();
    }
  }
}

// #89 comment 886 (③): wrap a range's contents PER LINE, so a mark that spans a <br> becomes
// `<strong>a</strong><br><strong>b</strong>` — NOT `<strong>a<br>b</strong>`. The latter serialises to
// `**a\nb**` (cellElToText), which renderCellInline then splits per line into `**a` + `b**` (both literal,
// unclosed) — the reported "multi-line cell decoration breaks". Grouping the extracted fragment's top-level
// nodes at <br> boundaries and wrapping each group keeps every line's mark self-closed and round-trippable.
// #89 comment 896: EDGE WHITESPACE must stay OUTSIDE the wrapper. A mark whose inner text begins or ends
// with a space (or the ZWSP insertBrAtCaret drops after a <br>) serialises to `**one **` / `** two**`,
// which CommonMark's emphasis flanking rules DON'T parse as emphasis (a `**` next to whitespace can't
// open/close) — so the mark renders as a literal `**` on commit and the styling vanishes. And a
// whitespace/ZWSP-only line segment must get NO wrapper at all (else `****`, an empty mark, leaks). So:
// group nodes per line, and for each line peel leading/trailing whitespace+ZWSP out of the wrapper.
const isBlankNode = (n: Node): boolean => n.nodeType === Node.TEXT_NODE && !/[^\s​]/.test(n.nodeValue ?? "");
function wrapPerLine(fragment: DocumentFragment, makeEl: () => HTMLElement): DocumentFragment {
  const out = document.createDocumentFragment();
  let line: Node[] = [];
  const flushLine = () => { if (line.length) wrapLineSegment(out, line, makeEl); line = []; };
  for (const node of Array.from(fragment.childNodes)) {
    if (node instanceof HTMLBRElement) { flushLine(); out.appendChild(node); continue; } // line break — end the run
    line.push(node);
  }
  flushLine();
  return out;
}
// Wrap ONE line's nodes, but with leading/trailing whitespace+ZWSP kept OUTSIDE the wrapper. A segment
// with no non-whitespace content gets no wrapper (its text is emitted as-is).
function wrapLineSegment(out: DocumentFragment, nodes: Node[], makeEl: () => HTMLElement): void {
  const hasContent = nodes.some((n) => n.nodeType !== Node.TEXT_NODE ? (n.textContent ?? "").length > 0 : !isBlankNode(n));
  if (!hasContent) { for (const n of nodes) out.appendChild(n); return; } // blank line — no empty mark
  const seg = nodes.slice();
  // Peel a leading whitespace run out of the FIRST text node (emit it before the wrapper).
  if (seg[0]!.nodeType === Node.TEXT_NODE) {
    const v = seg[0]!.nodeValue ?? "";
    const lead = v.length - v.replace(/^[\s​]+/, "").length;
    if (lead === v.length) { out.appendChild(seg.shift()!); } // whole node is whitespace → outside
    else if (lead > 0) { out.appendChild(document.createTextNode(v.slice(0, lead))); (seg[0] as Text).nodeValue = v.slice(lead); }
  }
  // Peel a trailing whitespace run out of the LAST text node (emit it after the wrapper).
  let trail: Node | null = null;
  const lastIdx = seg.length - 1;
  if (seg[lastIdx]!.nodeType === Node.TEXT_NODE) {
    const v = seg[lastIdx]!.nodeValue ?? "";
    const tlen = v.length - v.replace(/[\s​]+$/, "").length;
    if (tlen === v.length) { trail = seg.pop()!; }
    else if (tlen > 0) { trail = document.createTextNode(v.slice(v.length - tlen)); (seg[lastIdx] as Text).nodeValue = v.slice(0, v.length - tlen); }
  }
  const wrapper = makeEl();
  for (const n of seg) wrapper.appendChild(n);
  out.appendChild(wrapper);
  if (trail) out.appendChild(trail);
}

// #236 (review fix): a selection recorded as a cell-TEXT offset range survives a mark toggle,
// because toggling changes wrapper elements but NOT the visible text. Restoring by offset keeps the
// user's exact selection — re-selecting the whole cell (the old code) broke the toggle round-trip: a
// sub-range's 2nd press would see "the whole cell" and re-cover it instead of removing the mark.
// Offset space matches cellElToText: text chars, with each <br> counting as one '\n'.
function fragTextLen(node: Node): number {
  let n = 0;
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) n += (c.nodeValue ?? "").length;
    else if (c instanceof HTMLBRElement) n += 1;
    else n += fragTextLen(c);
  }
  return n;
}
function cellOffsetOf(el: HTMLElement, node: Node, nodeOffset: number): number {
  const r = document.createRange();
  r.setStart(el, 0);
  try { r.setEnd(node, nodeOffset); } catch { return 0; }
  return fragTextLen(r.cloneContents());
}
function cellPointAt(el: HTMLElement, target: number): { node: Node; offset: number } {
  let acc = 0;
  let last: { node: Node; offset: number } = { node: el, offset: 0 };
  const walk = (node: Node): { node: Node; offset: number } | null => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c.nodeValue ?? "").length;
        last = { node: c, offset: len };
        if (acc + len >= target) return { node: c, offset: target - acc };
        acc += len;
      } else if (c instanceof HTMLBRElement) {
        if (acc + 1 > target) { const i = Array.prototype.indexOf.call(c.parentNode!.childNodes, c); return { node: c.parentNode!, offset: i }; }
        acc += 1;
      } else {
        const hit = walk(c);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(el) ?? last;
}
// Re-select [from,to] (cell-text offsets) after a mutation; falls back to whole-cell only on error.
function restoreCellSelection(el: HTMLElement, sel: Selection, from: number, to: number): void {
  const a = cellPointAt(el, from), b = cellPointAt(el, to);
  const rr = document.createRange();
  try { rr.setStart(a.node, a.offset); rr.setEnd(b.node, b.offset); }
  catch { rr.selectNodeContents(el); }
  sel.removeAllRanges();
  sel.addRange(rr);
}

// TOGGLE the current selection's `mark` (#236) — the decoration appears/disappears in place (WYSIWYG).
// Fully marked selection → remove (extractContents splits partially-covered elements at the range
// boundaries, so the outside parts KEEP their mark — sub-range removal, word-processor style). Mixed or
// unmarked → apply-unify: same-tag wrappers inside the extracted fragment are unwrapped first, then the
// whole fragment is wrapped per line — never nested same-tag / ambiguous `**ab****cd**` output (adjacent
// same-tag siblings are merged after insert). Returns false for a collapsed / out-of-cell selection.
// DOM-space (no source-offset math), so it composes with OTHER marks (bold selection + italic nests
// em>strong; removing bold keeps the em). A selection crossing <br>s is handled per line (wrapPerLine).
export function applyCellMark(el: HTMLElement, mark: Mark): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !el.contains(range.commonAncestorContainer)) return false;
  // Record the selection as cell-text offsets BEFORE mutating — mark toggling leaves the text
  // unchanged, so we restore the SAME range afterward (not a whole-cell reselect).
  const selFrom = cellOffsetOf(el, range.startContainer, range.startOffset);
  const selTo = cellOffsetOf(el, range.endContainer, range.endOffset);
  try {
    // Split boundary same-tag elements so the working range's edges sit OUTSIDE them (otherwise the
    // re-insert lands back inside the mark and a "remove" is a no-op — the boundary-shell bug).
    const { startMarker, endMarker } = isolateRangeFromTags(el, range, mark.tags);
    const r = document.createRange();
    r.setStartAfter(startMarker);
    r.setEndBefore(endMarker);
    const fully = rangeFullyMarked(el, r, mark.tags);
    const frag = r.extractContents();
    unwrapTags(frag, mark.tags); // both paths: strip this mark inside the selection first
    r.insertNode(fully ? frag : wrapPerLine(frag, mark.el));
    startMarker.remove();
    endMarker.remove();
  } catch {
    return false; // a range crossing element boundaries that can't be extracted cleanly — no-op
  }
  el.normalize(); // merge any split text nodes so cellElToText reads clean runs
  mergeAdjacent(el, mark.tags); // also drops empty split shells
  restoreCellSelection(el, sel, selFrom, selTo); // keep the user's exact selection (toggle round-trip)
  return true;
}

// #89 comment 886 (②): apply a LINK with a real destination. Wraps each selected line's contents in an
// `<a href>` (per line, like applyCellMark), but ONLY if `url` passes safeHref — the SAME single scheme
// judge (ADR-037; no new XSS boundary). A dangerous/empty URL is a no-op (the text stays plain). Built with
// createElement, never innerHTML. Returns false for a collapsed / out-of-cell selection or a rejected URL.
export function applyCellLink(el: HTMLElement, url: string, safeHref: (u: string) => string | null, range?: Range): boolean {
  const href = safeHref(url.trim());
  if (!href) return false;
  const sel = window.getSelection();
  // Operate on the EXPLICIT range when given (the URL popover snapshots the cell selection before its input
  // steals focus — a focused <input> has its own selection, so window.getSelection() no longer points at the
  // cell). extractContents/insertNode work on any Range, independent of the document selection.
  const r = range ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
  if (!r || r.collapsed || !el.contains(r.commonAncestorContainer)) return false;
  // Same offset-restore as applyCellMark for the live-selection (toolbar) path (#236 review
  // fix). The popover path passes an explicit snapshot range and its input already stole focus, so
  // there is no live cell selection to preserve there.
  const linkFrom = cellOffsetOf(el, r.startContainer, r.startOffset);
  const linkTo = cellOffsetOf(el, r.endContainer, r.endOffset);
  try {
    const inserted = wrapPerLine(r.extractContents(), () => { const a = document.createElement("a"); a.setAttribute("href", href); return a; });
    r.insertNode(inserted);
  } catch {
    return false;
  }
  el.normalize();
  if (sel && !range) restoreCellSelection(el, sel, linkFrom, linkTo);
  return true;
}

// Mount the floating toolbar for a cell in edit mode. It shows only while a non-collapsed selection sits
// inside `cellEl`, positioned above the selection; a button mousedown applies its mark WITHOUT blurring the
// cell (preventDefault keeps focus/selection). destroy() removes it + its listeners.
export function mountCellFormatToolbar(cellEl: HTMLElement): { destroy(): void } {
  const bar = document.createElement("div");
  bar.className = "cm-lp-cell-format-bar";
  bar.setAttribute("data-testid", "cell-format-bar");
  bar.style.display = "none";
  for (const mark of CELL_MARKS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-lp-cell-format-btn";
    b.textContent = mark.label;
    b.setAttribute("data-testid", `cell-format-${mark.id}`);
    b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); applyCellMark(cellEl, mark); position(); });
    bar.appendChild(b);
  }
  // #89 comment 886 (②): the Link button opens a small URL input (the missing "enter the destination" step —
  // previously it wrapped a fixed placeholder href="url" that couldn't be edited). mousedown-preventDefault
  // keeps the cell's selection; we snapshot the range, then on confirm restore it and wrap via applyCellLink
  // (safeHref is the only scheme judge). Escape / blur cancels.
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "cm-lp-cell-format-btn";
  linkBtn.textContent = "Link";
  linkBtn.setAttribute("data-testid", "cell-format-link");
  let savedRange: Range | null = null;
  let popover: HTMLElement | null = null;
  let dismissPopover: ((e: Event) => void) | null = null;
  const closePopover = () => {
    if (dismissPopover) { document.removeEventListener("pointerdown", dismissPopover, true); dismissPopover = null; }
    popover?.remove();
    popover = null;
    savedRange = null;
  };
  linkBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !cellEl.contains(sel.anchorNode)) return;
    closePopover(); // clear any prior popover FIRST (it nulls savedRange) — then snapshot the selection
    savedRange = sel.getRangeAt(0).cloneRange();
    popover = document.createElement("div");
    popover.className = "cm-lp-cell-link-popover";
    popover.setAttribute("data-testid", "cell-link-popover");
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://…";
    input.setAttribute("data-testid", "cell-link-url");
    const confirm = () => {
      if (savedRange) applyCellLink(cellEl, input.value, safeHref, savedRange); // operate on the snapshot range
      closePopover();
      cellEl.focus(); // hand focus back to the cell so editing continues (its blur skipped the popover)
      position();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); confirm(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closePopover(); }
    });
    popover.appendChild(input);
    document.body.appendChild(popover);
    const r = savedRange.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${r.bottom + 6}px`;
    input.focus();
    // Click-away cancels (a pointerdown outside the popover). Deferred so THIS mousedown doesn't self-dismiss.
    // Not a blur handler — blur races with test drivers and focus churn; an explicit outside-pointerdown is
    // deterministic (mirrors the callout type menu).
    dismissPopover = (ev: Event) => { if (popover && !popover.contains(ev.target as Node)) closePopover(); };
    setTimeout(() => { if (dismissPopover) document.addEventListener("pointerdown", dismissPopover, true); }, 0);
  });
  bar.appendChild(linkBtn);
  document.body.appendChild(bar);

  const position = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !cellEl.contains(sel.anchorNode)) { bar.style.display = "none"; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
    let top = rect.top - bh - 6;
    if (top < 4) top = rect.bottom + 6; // flip below if it would clip the top
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  };
  const onSel = () => position();
  document.addEventListener("selectionchange", onSel);
  window.addEventListener("scroll", onSel, true);
  window.addEventListener("resize", onSel);
  return {
    destroy() {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("scroll", onSel, true);
      window.removeEventListener("resize", onSel);
      closePopover();
      bar.remove();
    },
  };
}
