// M1 PROTOTYPE SPIKE (#153 / ADR-054) — NOT shipping code. Wired only in DEV (editor-livepreview)
// to answer the focus go/no-go before the real beginTextEdit build. It models the M1 shape:
//   - an ATOMIC block widget whose ROOT is contenteditable=false (CM treats it as one atom, a
//     Decoration.replace → CM never reads the doc from inside it),
//   - an ACTIVE-CELL "island" that is a nested contenteditable=true,
//   - a focus guard: the widget IGNORES its own events (ignoreEvent) so CM doesn't process the
//     island's input/selection, and we never call view.focus() while the island is active.
// Commit is replaceSource-style: ONE doc change that writes the island's textContent back. The
// island NEVER writes Yjs directly and CM's dispatch/state are untouched (focus/selection only).
//
// Go/no-go (e2e m1-spike.spec): (1) focus stays in the island while typing, (2) CM doesn't reset
// its selection into contentDOM mid-type, (3) Esc/blur commits via the single dispatch, (4) both
// vim and non-vim. Trigger: the literal token `@SPIKE@` in the doc.
import { EditorView, Decoration, WidgetType, ViewPlugin, type DecorationSet } from "@codemirror/view"
import { RangeSetBuilder, type Extension } from "@codemirror/state"

const TOKEN = "@SPIKE@"

class IslandWidget extends WidgetType {
  constructor(readonly view: EditorView, readonly from: number, readonly to: number) { super() }
  eq(o: IslandWidget) { return o.from === this.from }
  // CM must NOT handle events originating inside the widget (the island owns its input + focus).
  ignoreEvent() { return true }
  toDOM() {
    const root = document.createElement("span")
    root.className = "m1-spike-root"
    root.contentEditable = "false" // atomic to CM: its selection can't enter, its DOM is opaque
    root.setAttribute("data-testid", "spike-root")

    const island = document.createElement("span")
    island.className = "m1-spike-island"
    island.contentEditable = "true" // the editable cell island
    island.setAttribute("data-testid", "spike-island")
    island.textContent = ""
    island.style.cssText = "display:inline-block;min-width:60px;border:1px solid #888;padding:0 4px;outline:2px solid transparent"

    // Commit = ONE replaceSource-style dispatch: write the island text into the doc AFTER the
    // token (focus/selection only otherwise; no Yjs from the island, no view.state poking).
    const commit = () => {
      const text = (island.textContent ?? "").replace(/\n/g, "")
      // re-resolve the token position against the CURRENT doc (it may have shifted)
      const at = this.view.state.doc.toString().indexOf(TOKEN)
      if (at < 0) return
      this.view.dispatch({ changes: { from: at + TOKEN.length, to: at + TOKEN.length, insert: text } })
    }
    island.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commit(); this.view.focus() }
    })
    island.addEventListener("blur", () => { commit() }, { once: true })
    // Focus the island on mousedown WITHOUT letting CM see it (so CM doesn't move its selection).
    root.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); island.focus() })

    root.appendChild(island)
    return root
  }
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  const at = text.indexOf(TOKEN)
  if (at >= 0) {
    b.add(at, at + TOKEN.length, Decoration.replace({ widget: new IslandWidget(view, at, at + TOKEN.length) }))
  }
  return b.finish()
}

export const m1Spike: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = build(view) }
    update(u: { docChanged: boolean; view: EditorView }) { if (u.docChanged) this.decorations = build(u.view) }
  },
  {
    decorations: (v) => v.decorations,
    // Atomic: CM cursor motion skips the token range (selection can't land mid-widget).
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
)
