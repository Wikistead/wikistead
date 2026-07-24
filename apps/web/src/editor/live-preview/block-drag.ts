// Block drag-to-reorder UI (ADR-036 / #84). A HOVER-FOLLOWING drag handle (Notion-style): hovering a
// top-level block shows a grip just outside the block's left edge; dragging it moves the whole block to
// the drop position as ONE transaction (computeBlockMove → one Yjs op). The grip + drop indicator are
// DISPLAY-ONLY (a floating DOM handle + a line decoration), never in the doc / never synced — presence
// and the single Y.Text are untouched. vim/non-vim identical (pointer-driven). Move math: block-move.ts.
//
// #84 comment 741: this REPLACED a fixed left-gutter grip. The gutter marker sat at the editor's far left
// (near the sidebar), always on — the reviewer couldn't associate it with a block. A handle that appears
// on hover, adjacent to the hovered block's left edge, is the expected affordance.
import { EditorView, Decoration, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from "@codemirror/view"
import { StateField, StateEffect, RangeSet, type Extension } from "@codemirror/state"
import { blockRangeAt, computeBlockMove } from "./block-move"

// ── drop indicator (display-only) ───────────────────────────────────────────
const setDropTarget = StateEffect.define<number | null>() // a line-start offset, or null
const dropLine = Decoration.line({ class: "cm-lp-block-droptarget" })
// #84 comment 750: the very-end drop. A target of doc.length means "append after the last block", which
// a top-border on the last line can't show (it reads as "before"). Render a BOTTOM-border on the last
// line instead so the user sees a drop slot after the last block even with no trailing blank line.
const dropLineEnd = Decoration.line({ class: "cm-lp-block-droptarget-end" })
const dropField = StateField.define<DecorationSet>({
  create: () => RangeSet.empty,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDropTarget)) {
        if (e.value == null) return RangeSet.empty
        const doc = tr.state.doc
        return e.value >= doc.length
          ? RangeSet.of([dropLineEnd.range(doc.lineAt(doc.length).from)]) // end-of-doc ⇒ last line's bottom
          : RangeSet.of([dropLine.range(doc.lineAt(e.value).from)])
      }
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Is `block` the last content block (no non-blank line after it)? An end-drop appends after it.
function isLastContentBlock(view: EditorView, blockTo: number): boolean {
  const doc = view.state.doc
  for (let n = doc.lineAt(blockTo).number + 1; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() !== "") return false
  }
  return true
}

// The block-start offset under viewport y (for the drop position); doc.length ⇒ append at the very end.
// #84 comment 750: also append at the end when the pointer is over the LOWER HALF of the LAST block, so a
// block can be dropped after the last one even when there is no trailing blank line to hover below it.
function targetUnder(view: EditorView, clientX: number, clientY: number): number {
  const pos = view.posAtCoords({ x: clientX, y: clientY })
  if (pos == null) return view.state.doc.length // below the last line ⇒ append
  const block = blockRangeAt(view.state, pos)
  if (block && isLastContentBlock(view, block.to)) {
    const top = view.coordsAtPos(block.from)?.top
    const bottom = view.coordsAtPos(block.to)?.bottom
    if (top != null && bottom != null && clientY > (top + bottom) / 2) return view.state.doc.length // lower half ⇒ append at end
  }
  return block ? block.from : view.state.doc.line(view.state.doc.lineAt(pos).number).from
}

// Start dragging the block anchored at `srcFrom` (re-resolved at drop so a concurrent insert
// above can't move the wrong block — anti-test #1). Pointer events are CAPTURED to the grip (#84):
// a page has block widgets (Excalidraw/mermaid/table) whose iframes/DOM otherwise SWALLOW pointermove
// once the pointer crosses them, so a plain window listener silently stops tracking mid-drag ("nothing
// moves") and the widget's own click (e.g. the Excalidraw modal) fires. setPointerCapture routes every
// pointermove/up to the grip until release, so the drag tracks over any widget and never triggers it.
function startDrag(view: EditorView, srcFrom: number, e: PointerEvent, grip: HTMLElement): void {
  e.preventDefault()
  e.stopPropagation()
  try { grip.setPointerCapture(e.pointerId) } catch { /* capture unsupported — degrade to element events */ }
  const move = (ev: PointerEvent) => view.dispatch({ effects: setDropTarget.of(targetUnder(view, ev.clientX, ev.clientY)) })
  const up = (ev: PointerEvent) => {
    grip.removeEventListener("pointermove", move)
    grip.removeEventListener("pointerup", up)
    try { grip.releasePointerCapture(ev.pointerId) } catch { /* already released */ }
    view.dispatch({ effects: setDropTarget.of(null) }) // clear the indicator
    const src = blockRangeAt(view.state, srcFrom) // re-resolve against the CURRENT doc
    if (!src) return
    const target = targetUnder(view, ev.clientX, ev.clientY)
    const res = computeBlockMove(view.state.doc, src, target)
    if (res) view.dispatch({ changes: res.changes }) // ONE transaction = one Yjs op
  }
  // Captured pointer events dispatch to the grip element, so listen THERE (not window).
  grip.addEventListener("pointermove", move)
  grip.addEventListener("pointerup", up)
}

// #84 comment 741: a single hover-following handle. On mousemove it resolves the top-level block under
// the pointer (works for BOTH text paragraphs and replaced widget atoms — blockRangeAt is tree-based, not
// line-based) and parks the grip just outside that block's left edge; leaving the editor (or hovering off
// any block) hides it. pointerdown starts the drag (startDrag owns capture + the move/drop). The handle
// is a plain DOM element under `view.dom` (the .cm-editor positioning context) — display-only, never in
// the doc. Hidden in Reading mode (readOnly).
const GRIP_GAP = 10 // px between the grip's right edge and the block's left edge (clearly outside the frame)
class HoverGrip implements PluginValue {
  private grip: HTMLElement
  private from = -1
  private dragging = false
  private onMove: (e: MouseEvent) => void
  private onLeave: () => void
  constructor(private view: EditorView) {
    const grip = document.createElement("div")
    grip.className = "cm-lp-block-grip"
    grip.textContent = "⠿"
    grip.dataset.tip = "Drag to move this block" // #530
    grip.setAttribute("data-testid", "block-grip")
    grip.style.display = "none"
    grip.addEventListener("mousedown", (e) => e.preventDefault()) // don't move the caret / start a selection
    grip.addEventListener("pointerdown", (e) => {
      if (this.from < 0) return
      this.dragging = true
      startDrag(this.view, this.from, e, grip)
      const done = () => { this.dragging = false; grip.removeEventListener("pointerup", done) }
      grip.addEventListener("pointerup", done)
    })
    this.grip = grip
    view.dom.appendChild(grip)
    this.onMove = (e) => this.position(e)
    this.onLeave = () => { if (!this.dragging) this.hide() }
    // CAPTURE phase on the whole editor: a block WIDGET (mermaid/table/excalidraw) can stopPropagation on
    // its own DOM, so a bubbling listener never fires over it and the grip never appeared on widget atoms.
    // Capturing fires on the way down, before any child can swallow it.
    view.dom.addEventListener("mousemove", this.onMove, true)
    view.dom.addEventListener("mouseleave", this.onLeave)
  }
  private hide() { this.grip.style.display = "none"; this.from = -1 }
  // #333: entering a read-only state (the Reading display mode) DETACHES the grip entirely — a grip
  // parked in Live/Source otherwise stayed visible on the clean Reading view forever (position()
  // early-returns under readOnly, so nothing ever hid it). Detach, not just display:none: "no drag
  // affordance in Reading" is the documented invariant (display-mode e2e pins count === 0), while on
  // the editable modes the element stays resident (hidden) for the hover-follow. position()
  // re-appends it when the surface becomes editable again.
  update(u: ViewUpdate) {
    if (u.state.readOnly && !u.startState.readOnly && !this.dragging) { this.hide(); this.grip.remove() }
  }
  // The block's TOP-LEVEL DOM element (direct child of cm-content) — a `.cm-line` for a paragraph or the
  // block wrapper for a replaced widget atom (mermaid/table/callout). Its rect gives the block's visual
  // left edge (the reading-column left, OUTSIDE which the handle must sit) and top, for both kinds.
  private blockEl(from: number): HTMLElement | null {
    const content = this.view.contentDOM
    let el: HTMLElement | null = (() => { const d = this.view.domAtPos(from); return (d.node.nodeType === 3 ? d.node.parentElement : d.node) as HTMLElement | null })()
    while (el && el.parentElement !== content) el = el.parentElement
    return el
  }
  // The top-level cm-content child (a `.cm-line` or a widget block) under a viewport point, if any.
  private blockElUnder(x: number, y: number): HTMLElement | null {
    const content = this.view.contentDOM
    let el = document.elementFromPoint(x, y) as HTMLElement | null
    while (el && el !== content && el.parentElement !== content) el = el.parentElement
    return el && el.parentElement === content ? el : null
  }
  private position(e: MouseEvent) {
    if (this.dragging || this.view.state.readOnly) return
    if (e.target === this.grip) return // hovering the grip itself → keep it parked (don't recompute/hide)
    // `false` = nearest position even when the pointer is over a block WIDGET (a precise hit returns null
    // there, which is why the grip never showed on mermaid/table atoms).
    // Resolve the block from the DOM element under the pointer FIRST (deterministic for both a `.cm-line`
    // and a replaced widget atom); posAtCoords over a widget's SVG can return null even with the inexact
    // flag, which is why widget atoms used to miss the grip. Fall back to posAtCoords for edge cases.
    let el = this.blockElUnder(e.clientX, e.clientY)
    let pos: number | null = null
    if (el) { try { pos = this.view.posAtDOM(el) } catch { pos = null } }
    if (pos == null) { pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false); el = null }
    if (pos == null) return this.hide()
    const block = blockRangeAt(this.view.state, pos)
    if (!block) return this.hide()
    if (block.from === this.from && this.grip.style.display === "block") return // same block, already shown
    const anchor = this.blockEl(block.from) ?? el
    if (!anchor) return this.hide()
    const b = anchor.getBoundingClientRect()
    const dom = this.view.dom.getBoundingClientRect()
    // Position relative to .cm-editor (the grip's offset parent), just OUTSIDE the block's left edge.
    // #333: appended lazily on show (and removed on hide), so a Reading/read-only surface has no
    // grip element at all. Append BEFORE measuring offsetWidth (0 while detached).
    if (!this.grip.isConnected) this.view.dom.appendChild(this.grip)
    this.grip.style.display = "block"
    this.grip.style.top = `${Math.round(b.top - dom.top)}px`
    this.grip.style.left = `${Math.round(Math.max(0, b.left - dom.left - this.grip.offsetWidth - GRIP_GAP))}px`
    this.from = block.from
  }
  destroy() {
    this.view.dom.removeEventListener("mousemove", this.onMove, true)
    this.view.dom.removeEventListener("mouseleave", this.onLeave)
    this.grip.remove()
  }
}
const hoverGrip = ViewPlugin.fromClass(HoverGrip)

export const blockDrag: Extension = [dropField, hoverGrip]
