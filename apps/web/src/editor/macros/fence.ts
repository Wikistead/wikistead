import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { findFenceMacro, type FenceMacro } from "./registry";

// Shared parsing of fenced-code blocks for the macro path. No DOM, no decorations
// dependency — imported by both the live-preview renderer and the fold module.
//
// Code-fence macros need NO new parser: @lezer/markdown already emits a `FencedCode`
// node and we read the info string from its first line. (The ::: directive path,
// slice 2, is the one that needs the in-house lezer extension.)

// The info string after the opening fence: ```mermaid -> "mermaid". null = no lang.
export function fenceLang(firstLineText: string): string | null {
  const m = /^\s*(?:`{3,}|~{3,})\s*([A-Za-z0-9_+-]+)/.exec(firstLineText);
  return m ? m[1]! : null;
}

// The body lines BETWEEN the fences (the fence lines themselves excluded).
export function fenceBody(doc: Text, from: number, to: number): string {
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(Math.min(to, doc.length)).number;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const t = doc.line(n).text;
    const s = t.trimStart();
    if (s.startsWith("```") || s.startsWith("~~~")) continue; // skip fence lines
    out.push(t);
  }
  return out.join("\n");
}

function resolveFence(state: EditorState, pos: number, side: -1 | 1) {
  let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
    syntaxTree(state).resolveInner(pos, side);
  while (node && node.name !== "FencedCode") node = node.parent;
  return node;
}

export interface MacroFence {
  readonly from: number; // start of the opening fence line (whole-block range)
  readonly to: number; // end of the closing fence line
  readonly lang: string;
  readonly macro: FenceMacro;
  readonly body: string;
}

// The macro fenced-code block covering `pos`, or null if pos isn't inside one (or its
// language has no registered macro). Used by the fold service / placeholder, which
// only have a position, not the renderer's node.
export function macroFenceAt(state: EditorState, pos: number): MacroFence | null {
  // Resolve from both sides: a position at the block's far edge (e.g. FencedCode.to,
  // which posAtDOM can yield for a block widget) misses the node with side +1 only.
  const node = resolveFence(state, pos, 1) ?? resolveFence(state, pos, -1);
  if (!node) return null;
  const doc = state.doc;
  const from = doc.lineAt(node.from).from;
  const to = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).to;
  const lang = fenceLang(doc.lineAt(node.from).text);
  if (!lang) return null;
  const macro = findFenceMacro(lang);
  if (!macro) return null;
  return { from, to, lang, macro, body: fenceBody(doc, node.from, node.to) };
}
