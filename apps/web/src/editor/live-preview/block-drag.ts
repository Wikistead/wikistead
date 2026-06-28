// Block drag-to-reorder UI (ADR-036 / #84). A left-gutter grip per top-level block; dragging
// it moves the whole block to the drop position as ONE transaction (computeBlockMove → one Yjs
// op). The grip + drop indicator are DISPLAY-ONLY (gutter marker + a line decoration), never in
// the doc / never synced — presence and the single Y.Text are untouched. vim/non-vim identical
// (it's pointer-driven, not a keymap). The move math lives in block-move.ts (unit-tested).
import { gutter, GutterMarker, EditorView, Decoration, type DecorationSet } from "@codemirror/view"
import { StateField, StateEffect, RangeSet, type Extension } from "@codemirror/state"
import { blockRangeAt, computeBlockMove } from "./block-move"

// ── drop indicator (display-only) ───────────────────────────────────────────
const setDropTarget = StateEffect.define<number | null>() // a line-start offset, or null
const dropLine = Decoration.line({ class: "cm-lp-block-droptarget" })
const dropField = StateField.define<DecorationSet>({
  create: () => RangeSet.empty,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDropTarget)) {
        return e.value == null ? RangeSet.empty : RangeSet.of([dropLine.range(tr.state.doc.lineAt(e.value).from)])
      }
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// The block-start offset under viewport y (for the drop position); doc.length when below all.
function targetUnder(view: EditorView, clientX: number, clientY: number): number {
  const pos = view.posAtCoords({ x: clientX, y: clientY })
  if (pos == null) return view.state.doc.length // below the last line ⇒ append
  const block = blockRangeAt(view.state, pos)
  return block ? block.from : view.state.doc.line(view.state.doc.lineAt(pos).number).from
}

// Start dragging the block anchored at `srcFrom` (re-resolved at drop so a concurrent insert
// above can't move the wrong block — anti-test #1).
function startDrag(view: EditorView, srcFrom: number, e: PointerEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const move = (ev: PointerEvent) => view.dispatch({ effects: setDropTarget.of(targetUnder(view, ev.clientX, ev.clientY)) })
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    view.dispatch({ effects: setDropTarget.of(null) }) // clear the indicator
    const src = blockRangeAt(view.state, srcFrom) // re-resolve against the CURRENT doc
    if (!src) return
    const target = targetUnder(view, ev.clientX, ev.clientY)
    const res = computeBlockMove(view.state.doc, src, target)
    if (res) view.dispatch({ changes: res.changes }) // ONE transaction = one Yjs op
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
}

class GripMarker extends GutterMarker {
  constructor(readonly view: EditorView, readonly from: number) { super() }
  eq(o: GripMarker) { return o.from === this.from }
  toDOM() {
    const el = document.createElement("span")
    el.className = "cm-lp-block-grip"
    el.textContent = "⠿"
    el.title = "Drag to move this block"
    el.setAttribute("data-testid", "block-grip")
    el.addEventListener("pointerdown", (e) => startDrag(this.view, this.from, e))
    return el
  }
}

// A grip on the FIRST line of every top-level block (blockRangeAt.from === line.from).
const blockGutter = gutter({
  class: "cm-lp-block-gutter",
  lineMarker: (view, line) => {
    if (view.state.readOnly) return null // Reading mode (#164): no drag affordance on a clean view
    const b = blockRangeAt(view.state, line.from)
    return b && b.from === line.from ? new GripMarker(view, line.from) : null
  },
})

export const blockDrag: Extension = [dropField, blockGutter]
