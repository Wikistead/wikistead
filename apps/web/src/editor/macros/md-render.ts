import { parser } from "@lezer/markdown";
import { directiveExtension, parseDirectiveOpen } from "./directive-parser";
import { findDirectiveMacro } from "./registry";
import { currentMacroTheme } from "./theme";

// #90 S0 (A′ shared) — render a Markdown source string to a SANITIZED DOM fragment, for use
// INSIDE a block-widget macro (columns / tabs) that can't reach CodeMirror's own renderers (the
// macro host is `{theme}` only). Built on the same @lezer/markdown parser the editor uses (no new
// dependency). SECURITY: this is the XSS boundary — DOM is built node-by-node from an allowlist;
// text is set via textContent (never innerHTML); raw HTML in the source is rendered as LITERAL
// TEXT (the HTML* nodes fall through to the text default), so `<script>` can never execute; link
// hrefs are scheme-checked. Anything unhandled degrades to its source text (safe).

const mdParser = parser.configure(directiveExtension);
// @lezer/common isn't a direct dependency — derive the SyntaxNode type from the parser instead.
type SNode = ReturnType<typeof mdParser.parse>["topNode"];

// Mark/structural nodes whose own text must NOT be emitted (the `*`/`#`/`[` `]` `(` `)` etc.).
const MARKS = new Set([
  "EmphasisMark", "CodeMark", "LinkMark", "HeaderMark", "QuoteMark", "ListMark",
  "DirectiveMark", "URL", "CodeInfo", "LinkTitle",
]);

// Block-level nodes get their own recursion; everything else is inline/text.
const HEADINGS: Record<string, string> = {
  ATXHeading1: "h1", ATXHeading2: "h2", ATXHeading3: "h3", ATXHeading4: "h4", ATXHeading5: "h5", ATXHeading6: "h6",
  SetextHeading1: "h1", SetextHeading2: "h2",
};

// Block dangerous schemes; allow everything else (relative, https, mailto, …). Never throws.
// The blocklist POLICY is unchanged; this normalizes the URL the way a browser does BEFORE checking,
// so the check can't be evaded and legit URLs aren't mangled:
//   1. Strip a surrounding <…> (CommonMark angle-bracket destinations arrive WITH the brackets from
//      the parser). Without this a legit `<https://x>` renders as the broken relative href `<https://x>`,
//      and a `<javascript:…>` only failed to fire by accident (the literal `<` made it a relative URL).
//   2. Remove the control chars a browser IGNORES inside a URL before evaluating the scheme
//      (TAB/LF/CR/NUL + other C0/DEL) — otherwise `java⇥script:` would slip past the blocklist yet
//      execute once the browser drops the tab. Matching the browser's normalization closes that.
function safeHref(url: string): string | null {
  let u = url.trim();
  if (u.length >= 2 && u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1); // angle-bracket destination
  // eslint-disable-next-line no-control-regex -- deliberately stripping the control chars browsers ignore in URLs
  u = u.replace(/[\u0000-\u001F\u007F]/g, ""); // C0 controls + DEL (incl. TAB/LF/CR/NUL)
  if (/^\s*(javascript|data|vbscript|file):/i.test(u)) return null;
  const trimmed = u.trim();
  return trimmed || null;
}

const txt = (src: string, n: SNode) => src.slice(n.from, n.to);

// Render the children of `parent` over [from,to): emit a text node for each gap, recurse into
// inline child nodes, and SKIP mark nodes (so `**x**` becomes <strong>x</strong>, not `**x**`).
function renderInline(parent: SNode, src: string, into: Node): void {
  let pos = parent.from;
  let first = true; // trim the leading syntax space after an opening mark (e.g. "# " / "- " / "> ")
  const pushText = (s: string) => {
    const v = first ? s.replace(/^[ \t]+/, "") : s;
    if (v) { into.appendChild(document.createTextNode(v)); first = false; }
  };
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.from > pos) pushText(src.slice(pos, c.from));
    if (!MARKS.has(c.name)) { renderInlineNode(c, src, into); first = false; }
    pos = c.to;
  }
  if (pos < parent.to) pushText(src.slice(pos, parent.to));
}

function renderInlineNode(node: SNode, src: string, into: Node): void {
  switch (node.name) {
    case "Emphasis": { const el = document.createElement("em"); renderInline(node, src, el); into.appendChild(el); return; }
    case "StrongEmphasis": { const el = document.createElement("strong"); renderInline(node, src, el); into.appendChild(el); return; }
    case "Strikethrough": { const el = document.createElement("s"); renderInline(node, src, el); into.appendChild(el); return; }
    case "InlineCode": { const el = document.createElement("code"); el.textContent = stripMarks(node, src, "CodeMark"); into.appendChild(el); return; }
    case "Link": {
      const urlNode = node.getChild("URL");
      const href = urlNode ? safeHref(txt(src, urlNode)) : null;
      const el = document.createElement(href ? "a" : "span");
      if (href) { (el as HTMLAnchorElement).href = href; (el as HTMLAnchorElement).rel = "noopener noreferrer nofollow"; }
      renderInline(node, src, el); // link text (marks + URL skipped)
      into.appendChild(el);
      return;
    }
    case "HardBreak": into.appendChild(document.createElement("br")); return;
    // HTML*, and anything else inline → literal text (the XSS-safe default).
    default: into.appendChild(document.createTextNode(txt(src, node)));
  }
}

// The text of `node` minus a given mark (e.g. InlineCode without its backticks).
function stripMarks(node: SNode, src: string, mark: string): string {
  let out = "", pos = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === mark) { if (c.from > pos) out += src.slice(pos, c.from); pos = c.to; }
  }
  out += src.slice(pos, node.to);
  return out;
}

function renderBlock(node: SNode, src: string, into: Node): void {
  if (HEADINGS[node.name]) { const el = document.createElement(HEADINGS[node.name]!); renderInline(node, src, el); into.appendChild(el); return; }
  switch (node.name) {
    case "Paragraph": { const el = document.createElement("p"); renderInline(node, src, el); into.appendChild(el); return; }
    case "Blockquote": { const el = document.createElement("blockquote"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "BulletList": { const el = document.createElement("ul"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "OrderedList": { const el = document.createElement("ol"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "ListItem": { const el = document.createElement("li"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "FencedCode": case "CodeBlock": {
      const pre = document.createElement("pre"); const code = document.createElement("code");
      const t = node.getChild("CodeText");
      code.textContent = t ? txt(src, t) : "";
      pre.appendChild(code); into.appendChild(pre); return;
    }
    case "HorizontalRule": into.appendChild(document.createElement("hr")); return;
    case "Directive": {
      // ADR-085 shared macro renderer: dispatch a nested directive to its registered macro's
      // liveRender (the SINGLE source of truth) so a `:::callout`/`:::columns` etc. INSIDE a
      // transclude / column / tab renders as the real macro — not a generic box (#108, nested #90).
      // Container macros call renderMarkdownToDom on their sub-bodies, so nesting recurses here to any
      // depth. Unknown name / no liveRender / a macro that THROWS → the safe generic box (never break
      // the whole render). liveRender only gets `{theme}` (ADR-024 narrow host-API) — display-only.
      const full = src.slice(node.from, node.to);
      const nl = full.indexOf("\n");
      const parsed = parseDirectiveOpen(nl === -1 ? full : full.slice(0, nl));
      const macro = parsed ? findDirectiveMacro(parsed.name) : undefined;
      if (macro?.liveRender) {
        const lines = full.split("\n").slice(1); // drop the opening ::: line
        if (lines.length && /^\s*:::+\s*$/.test(lines[lines.length - 1]!)) lines.pop(); // drop close :::
        try {
          into.appendChild(macro.liveRender(lines.join("\n"), { theme: currentMacroTheme() }));
          return;
        } catch { /* a macro that throws must not break the render → fall through to the generic box */ }
      }
      const el = document.createElement("div"); el.className = "cm-lp-md-directive";
      renderBlocks(node, src, el); into.appendChild(el); return;
    }
    // Unknown block (incl. HTMLBlock) → literal text, safe.
    default: { const p = document.createElement("p"); p.textContent = txt(src, node); into.appendChild(p); }
  }
}

// Render the BLOCK children of a container (skipping marks); leaf inline content under a block
// without block children is handled by renderBlock's inline path.
function renderBlocks(parent: SNode, src: string, into: Node): void {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (MARKS.has(c.name)) continue;
    renderBlock(c, src, into);
  }
}

// Parse `src` as Markdown and return a sanitized DOM fragment. Safe by construction (no innerHTML).
export function renderMarkdownToDom(src: string): DocumentFragment {
  const tree = mdParser.parse(src);
  const frag = document.createDocumentFragment();
  renderBlocks(tree.topNode, src, frag);
  return frag;
}
