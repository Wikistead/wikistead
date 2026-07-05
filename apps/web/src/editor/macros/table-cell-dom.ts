// DOM helpers for table cell text (ADR-037 / #86), shared by the read render (table.ts) and
// the modal cell editor (table-edit.ts) — kept in a separate module so neither imports the
// other (no cycle). The XSS boundary holds: cell content is only ever text nodes + <br>
// elements; innerHTML is NEVER read or written for cell text.

import { renderMarkdownToDom } from "./md-render";

// #89 / ADR-097: render a BLOCK cell's Markdown through the shared sanitized renderer and mount the
// resulting subtree. The renderer is allowlist-by-construction (h1-6/p/ul/ol/li/blockquote/code/… only;
// a raw <iframe>/<script> in the source degrades to escaped text, never a live tag) and builds nodes via
// createElement + textContent — so ADR-037's "never innerHTML of untrusted text" holds: we mount a
// TRUSTED sanitized subtree, we never write raw user HTML. An in-cell embed/image is a DIRECTIVE and
// hits the renderer's macro dispatch (its own #108/image gate), so a table cell can't smuggle a raw
// iframe past the embed protections.
export function setCellBlock(el: HTMLElement, markdown: string): void {
  el.textContent = "";
  el.classList.add("cm-lp-cell-block");
  el.appendChild(renderMarkdownToDom(markdown));
}

// Render cell text into an element, preserving in-cell newlines as <br> ELEMENTS (never innerHTML).
export function setCellText(el: HTMLElement, text: string): void {
  el.textContent = "";
  text.split("\n").forEach((part, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    if (part) el.appendChild(document.createTextNode(part));
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
      out += cellElToText(node);
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
