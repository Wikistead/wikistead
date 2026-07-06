// DOM helpers for table cell text (ADR-037 / #86), shared by the read render (table.ts) and
// the modal cell editor (table-edit.ts) — kept in a separate module so neither imports the
// other (no cycle). The XSS boundary holds: cell content is only ever text nodes + <br>
// elements; innerHTML is NEVER read or written for cell text.

// #89 (rescoped, 2026-07-05): a table cell is INLINE TEXT ONLY. Block content (lists/paragraphs/headings)
// and macro rendering in cells were removed — a cell forcing the `:::table` HTML tier for arbitrary blocks
// broke Open formats (#3) for a marginal feature Notion/Obsidian don't have, and opened an XSS surface.
// Cells keep the ADR-037 invariant: text nodes + <br>, innerHTML NEVER read/written. (The inline-decoration
// toolbar inside a cell — select text → bold/italic — is the redefined follow-up; the cell edits raw source.)

import { renderInlineMarkdownToDom } from "./md-render";

// Render cell text into an element, preserving in-cell newlines as <br> ELEMENTS (never innerHTML).
export function setCellText(el: HTMLElement, text: string): void {
  el.textContent = "";
  text.split("\n").forEach((part, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    if (part) el.appendChild(document.createTextNode(part));
  });
}

// #89 (comment 830): the WYSIWYG cell surface. Renders the cell's Markdown source with its INLINE marks
// SHOWN (bold/italic/strike/code/link) instead of literal `**a**`, per line, joined by <br>. The marks are
// em/strong/s/code/a built by the shared allowlist-by-construction renderer (renderInlineMarkdownToDom) —
// NEVER innerHTML, so the ADR-037 / #89 XSS boundary holds. cellElToText reads these back to Markdown.
export function renderCellInline(el: HTMLElement, text: string): void {
  el.textContent = "";
  text.split("\n").forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    el.appendChild(renderInlineMarkdownToDom(line));
  });
}

// Read a (contenteditable) cell back to canonical cell text: text nodes verbatim, <br> -> "\n".
// Reads via the DOM tree (textContent + <br>), NEVER innerHTML, so pasted/typed rich markup
// cannot survive as markup. Resize-handle spans the editor appends inside the cell are skipped.
export function cellElToText(el: HTMLElement): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue ?? "";
    else if (node instanceof HTMLBRElement) out += "\n";
    else if (node instanceof HTMLElement) {
      if (node.classList.contains("cm-lp-col-resize") || node.classList.contains("cm-lp-row-resize")) continue;
      // #89 (comment 830): serialise the WYSIWYG inline-mark elements back to Markdown source (round-trip),
      // so the cell's canonical text stays Markdown even though it DISPLAYS decorated. Unknown elements
      // (never produced by renderCellInline — belt-and-braces) contribute only their text.
      const inner = cellElToText(node);
      switch (node.tagName) {
        case "STRONG": case "B": out += `**${inner}**`; break;
        case "EM": case "I": out += `*${inner}*`; break;
        case "S": case "DEL": case "STRIKE": out += `~~${inner}~~`; break;
        case "CODE": out += `\`${inner}\``; break;
        case "A": out += `[${inner}](${(node as HTMLAnchorElement).getAttribute("href") ?? ""})`; break;
        default: out += inner;
      }
    }
  }
  return out;
}

// Insert a single <br> at the caret (Shift+Enter = in-cell newline), caret after it. Used so
// the editor fully controls newline insertion (never the browser default <div>/<p>).
export function insertBrAtCaret(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement("br");
  range.insertNode(br);
  const after = document.createTextNode("​"); // zero-width so the caret can sit after a trailing <br>
  br.after(after);
  range.setStartAfter(after);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Insert plain text at the caret, newlines as <br> (paste handler — only text/plain is read,
// so pasted rich markup cannot survive as markup).
export function insertTextAtCaret(text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const frag = document.createDocumentFragment();
  text.split(/\r?\n/).forEach((p, i) => {
    if (i > 0) frag.appendChild(document.createElement("br"));
    if (p) frag.appendChild(document.createTextNode(p));
  });
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) { range.setStartAfter(last); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
}

// Strip the zero-width spaces insertBrAtCaret leaves behind, so they never reach the source.
export function stripZeroWidth(s: string): string {
  return s.replace(/​/g, "");
}
