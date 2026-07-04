import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { findFenceMacro, findDirectiveMacro, type FenceMacro, type DirectiveMacro } from "./registry";
import { parseDirectiveOpen } from "./directive-parser";
import { parsePipe, parseHtml, type Grid } from "./table-model";

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

export interface MacroDirective {
  readonly from: number; // start of the opening ::: line (whole-block range)
  readonly to: number; // end of the closing ::: line
  readonly name: string;
  readonly macro: DirectiveMacro;
  readonly body: string; // the lines BETWEEN the fences (e.g. the HTML <table>)
}

// The macro directive block (:::name … :::) covering `pos`, or null. Used by the
// reveal↔render mechanism / table render. body = content lines between the fences.
// Map a `Directive` syntax node → a resolved MacroDirective (null if the open line doesn't name a
// registered directive macro). Shared by directiveMacroAt (innermost) and directiveChainAt (nesting).
function nodeToDirective(state: EditorState, node: { from: number; to: number }): MacroDirective | null {
  const doc = state.doc;
  const open = parseDirectiveOpen(doc.lineAt(node.from).text);
  if (!open) return null;
  const macro = findDirectiveMacro(open.name);
  if (!macro) return null;
  const from = doc.lineAt(node.from).from;
  const lastLine = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1));
  const firstLine = doc.lineAt(node.from);
  const parts: string[] = []; // body = lines strictly between the opening and closing fence lines
  for (let n = firstLine.number + 1; n < lastLine.number; n++) parts.push(doc.line(n).text);
  return { from, to: lastLine.to, name: open.name, macro, body: parts.join("\n") };
}

export function directiveMacroAt(state: EditorState, pos: number): MacroDirective | null {
  let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== "Directive") node = node.parent;
  if (!node) {
    node = syntaxTree(state).resolveInner(pos, -1);
    while (node && node.name !== "Directive") node = node.parent;
  }
  if (!node) return null;
  return nodeToDirective(state, node);
}

// #196 / ADR-092: the NESTING CHAIN of directive macros containing `pos`, OUTERMOST first → INNERMOST
// last (the last element === directiveMacroAt). This is the foundation for "innermost-wins" reveal: a
// container renders as a panel while only the innermost macro the caret is in reveals its raw source.
// Pure (syntax tree only). Directives whose open line names no registered macro are skipped (a plain
// nested block is not a macro layer). Empty when the caret is in no directive.
export function directiveChainAt(state: EditorState, pos: number): MacroDirective[] {
  const tree = syntaxTree(state);
  type Node = ReturnType<typeof tree.resolveInner>;
  // At a boundary the forward resolve may sit outside the block; fall back to the backward resolve if
  // no Directive ancestor is found on the forward side.
  const collect = (start: Node): { from: number; to: number }[] => {
    const out: { from: number; to: number }[] = [];
    let n: Node | null = start;
    while (n) {
      if (n.name === "Directive") out.push({ from: n.from, to: n.to });
      n = n.parent;
    }
    return out;
  };
  let dirs = collect(tree.resolveInner(pos, 1));
  if (dirs.length === 0) dirs = collect(tree.resolveInner(pos, -1));
  // `dirs` is innermost-first (walked up from the caret) → reverse to outermost-first, then resolve.
  return dirs
    .reverse()
    .map((n) => nodeToDirective(state, n))
    .filter((d): d is MacroDirective => d !== null);
}

export interface TableBlock {
  readonly from: number;
  readonly to: number;
  readonly tier: "pipe" | "html"; // Tier-1 GFM pipes vs Tier-2 :::table HTML
  readonly grid: Grid;
}

// The table block (a GFM pipe Table OR a :::table directive) covering `pos`, parsed into
// the shared grid model — the unit the cell-merge UI edits. null if pos isn't in a table.
export function tableBlockAt(state: EditorState, pos: number): TableBlock | null {
  const dir = directiveMacroAt(state, pos);
  if (dir && dir.name === "table") return { from: dir.from, to: dir.to, tier: "html", grid: parseHtml(dir.body) };
  let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== "Table") node = node.parent;
  if (!node) {
    node = syntaxTree(state).resolveInner(pos, -1);
    while (node && node.name !== "Table") node = node.parent;
  }
  if (!node) return null;
  const doc = state.doc;
  const from = doc.lineAt(node.from).from;
  // #141: the lezer GFM `Table` node can ABSORB following paragraph lines when no blank line separates
  // them, so the rendered table widget covered those paragraphs and collapsed them to one y — vim j/k
  // then skipped the swallowed lines (measured: a table block reported {11,15} eating two trailing
  // paragraphs). Clip the range to the ACTUAL table rows — the contiguous run of pipe-bearing lines from
  // the node start — so the widget (and the motion atom) covers only the table.
  const startLine = doc.lineAt(node.from).number;
  const nodeEndLine = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).number;
  let endLine = startLine;
  for (let n = startLine; n <= nodeEndLine; n++) {
    if (doc.line(n).text.includes("|")) endLine = n;
    else break; // first non-table (no-pipe) line ends the table — trailing paragraphs are not the table
  }
  const to = doc.line(endLine).to;
  return { from, to, tier: "pipe", grid: parsePipe(doc.sliceString(from, to)) };
}
