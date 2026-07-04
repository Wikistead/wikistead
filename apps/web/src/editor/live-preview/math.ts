// #158-C3 / ADR-052: math rendering. Inline $…$ and block $$…$$ render via KaTeX (MIT) as ATOMS
// the source hides and a rendered formula shows, EXCEPT when the caret is inside (reveal-on-cursor,
// like every other marker) — so you edit the raw TeX in place. Display-only (no doc/offset/presence
// change); collaborators each reveal independently. KaTeX runs trust:false + strict (no \href / no
// arbitrary HTML; it builds DOM via katex.render — never innerHTML of user text), so it's XSS-safe.
// A `$` inside code (inline `code`, fenced blocks) is NOT math — skipped via the syntax tree.
import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view"
import { StateField, EditorState, RangeSetBuilder, type Range } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import katex from "katex"
import { displayMode, syntaxRevealsAt, motionAtomProvider, observeBlockResize } from "./decorations"

interface MathRange { from: number; to: number; tex: string; display: boolean }

// Is `pos` inside a code/comment construct (where a `$` is literal, not math)?
function inCode(state: EditorState, pos: number): boolean {
  let n = syntaxTree(state).resolveInner(pos, 1)
  for (; n; n = n.parent as typeof n) {
    if (!n) break
    if (/Code|Comment/.test(n.name)) return true
    if (!n.parent) break
  }
  return false
}

// Find $$…$$ (block) and $…$ (inline) spans in the doc. Block scanned first (so its $$ aren't
// mistaken for two inline $). Both require a non-empty body; inline stays on one line. Escaped \$
// is not a delimiter. Matches inside code are dropped.
export function findMath(state: EditorState): MathRange[] {
  const text = state.doc.toString()
  const out: MathRange[] = []
  const taken: [number, number][] = []
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x)
  const esc = (i: number) => i > 0 && text[i - 1] === "\\"
  // Block $$…$$
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "$" && text[i + 1] === "$" && !esc(i)) {
      let j = i + 2
      while (j < text.length - 1 && !(text[j] === "$" && text[j + 1] === "$" && !esc(j))) j++
      if (j < text.length - 1 && text[j] === "$" && text[j + 1] === "$") {
        const from = i, to = j + 2, tex = text.slice(i + 2, j).trim()
        if (tex && !inCode(state, from)) { out.push({ from, to, tex, display: true }); taken.push([from, to]) }
        i = j + 1
      }
    }
  }
  // Inline $…$ (single line, not part of a block already taken). #141 (approved judgment ②): the FULL
  // Pandoc/CommonMark-math delimiter rule so prose with currency is NOT math-ified
  // (1) the OPENING $ is followed by a non-whitespace char,
  // (2) the CLOSING $ is preceded by a non-whitespace char,
  // (3) the CLOSING $ is NOT immediately followed by a digit.
  // (1)+(2) reject "$5 and $6" (closing preceded by a space); (3) rejects "$5 and$6" / "$100$200" (the
  // closing $ runs into a number). "$x^2$" still matches.
  const nonWs = (c: string | undefined) => !!c && !/\s/.test(c)
  const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9"
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && !esc(i) && text[i + 1] !== "$" && !overlaps(i, i + 1) && nonWs(text[i + 1])) {
      let j = i + 1
      while (j < text.length && text[j] !== "$" && text[j] !== "\n") { if (text[j] === "\\") j++; j++ }
      if (j < text.length && text[j] === "$" && !esc(j) && nonWs(text[j - 1]) && !isDigit(text[j + 1])) {
        const from = i, to = j + 1, tex = text.slice(i + 1, j).trim()
        if (tex && !overlaps(from, to) && !inCode(state, from)) { out.push({ from, to, tex, display: false }); taken.push([from, to]) }
        i = j
      }
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

class MathWidget extends WidgetType {
  private ro?: ResizeObserver
  constructor(readonly tex: string, readonly display: boolean) { super() }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span")
    el.className = this.display ? "cm-lp-math cm-lp-math-block" : "cm-lp-math cm-lp-math-inline"
    el.setAttribute("data-testid", this.display ? "math-block" : "math-inline")
    // KaTeX builds DOM into `el` (not innerHTML of user text). trust:false + strict = XSS-safe;
    // throwOnError:false renders a red error node instead of throwing on a bad formula.
    try {
      katex.render(this.tex, el, { displayMode: this.display, throwOnError: false, trust: false, strict: "warn" })
    } catch {
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`
    }
    // #141: a DISPLAY math block is a multi-line block widget — like table/mermaid it MUST feed its
    // rendered height back to CM (ResizeObserver → requestMeasure), else CM's heightMap is short for the
    // math block and every line BELOW it gets a stale coordsAtPos → vim j/k drifts (measured: a `$$…$$`
    // before a callout made the callout region skip every other line). the project design notes: " block
    // widget ResizeObserver + requestMeasure CM " — math was the one block widget missing it.
    if (this.display) this.ro = observeBlockResize(view, el)
    return el
  }
  destroy() { this.ro?.disconnect(); this.ro = undefined }
  ignoreEvent() { return false }
}

function rangeRevealed(state: EditorState, from: number, to: number): boolean {
  return syntaxRevealsAt(
    state.facet(displayMode),
    state.readOnly,
    state.selection.ranges.some((r) => r.from <= to && r.to >= from),
  )
}

function buildMath(state: EditorState): { deco: DecorationSet; atomic: DecorationSet; blocks: { from: number; to: number }[] } {
  const all: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  const blocks: { from: number; to: number }[] = [] // #141/#183: DISPLAY ($$) atoms only, for motion
  for (const m of findMath(state)) {
    if (rangeRevealed(state, m.from, m.to)) continue // caret inside → show raw TeX (editable)
    const w = Decoration.replace({ widget: new MathWidget(m.tex, m.display), block: m.display })
    all.push(w.range(m.from, m.to))
    hidden.push(Decoration.replace({}).range(m.from, m.to))
    if (m.display) blocks.push({ from: m.from, to: m.to }) // block widget → a vertical-motion atom
  }
  const by = (a: Range<Decoration>, b: Range<Decoration>) => a.from - b.from
  const b1 = new RangeSetBuilder<Decoration>(); all.sort(by).forEach((r) => b1.add(r.from, r.to, r.value))
  const b2 = new RangeSetBuilder<Decoration>(); hidden.sort(by).forEach((r) => b2.add(r.from, r.to, r.value))
  return { deco: b1.finish(), atomic: b2.finish(), blocks }
}

export const mathField = StateField.define<{ deco: DecorationSet; atomic: DecorationSet; blocks: { from: number; to: number }[] }>({
  create: (state) => buildMath(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildMath(tr.state)
    if (tr.startState.facet(displayMode) !== tr.state.facet(displayMode)) return buildMath(tr.state)
    return value
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    // #141/#183: feed the display-math atom ranges into blockEntry's vertical-motion correction (its
    // model reads only livePreview.blocks). Without this, j overshoots a $$…$$ block by its rendered
    // height and k warps up from far below (the reported asymmetry); with it, motion steps one line.
    motionAtomProvider.of((state) => state.field(f).blocks),
  ],
})
