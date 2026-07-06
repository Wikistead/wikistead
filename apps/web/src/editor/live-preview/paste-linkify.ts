import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { safeHref } from "../macros/md-render";

// #223 / ADR-none (rides on ADR-037 + safeHref): auto-linkify a pasted URL / rich link into Markdown
// `[text](url)`, so the source stays plain Markdown (Open formats) while the live preview shows it clickable.
// The SAME `safeHref` is the ONLY scheme judgment (no new XSS boundary): a javascript:/data:/vbscript:/file:
// href is never linkified (falls back to a plain-text paste). Rich HTML (text/html) is read via DOMParser —
// NEVER innerHTML on a live node — and only the anchor's href (safeHref'd) + textContent are used.

const BARE_URL = /^https?:\/\/\S+$/i; // v1: explicit http/https scheme only (www./scheme-less → plain paste)

// Escape the Markdown link syntax so pasted text can't break out of `[...]` / `(...)`.
const escLinkText = (s: string): string => s.replace(/[[\]\\]/g, "\\$&");
const emitHref = (url: string): string => (/[()\s]/.test(url) ? `<${url}>` : url); // angle-wrap if it has ()/space

// The pasted HTML is a SINGLE anchor whose visible text is the whole paste → its href + text (else null).
// DOMParser.parseFromString does not execute scripts and builds an inert tree; we read attributes/textContent
// only (no innerHTML, no live DOM). Returns null when the paste is more than just one link (don't mangle it).
function singleAnchor(html: string): { href: string; text: string } | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  const anchors = doc.querySelectorAll("a[href]");
  if (anchors.length !== 1) return null;
  const a = anchors[0]!;
  const bodyText = (doc.body.textContent ?? "").trim();
  const aText = (a.textContent ?? "").trim();
  if (!bodyText || bodyText !== aText) return null; // extra content around the link → leave it to default paste
  return { href: a.getAttribute("href") ?? "", text: aText };
}

// Pure decision: the Markdown to INSERT (replacing the current selection), or null to fall back to the
// editor's default paste. `selectedText` is the text the paste replaces (wrapped as the link anchor for a
// bare-URL paste, the "paste a link onto selected text" convention).
export function linkifyPaste(input: { text: string; html: string; selectedText: string }): string | null {
  const text = (input.text ?? "").trim();
  const html = input.html ?? "";
  // 1. Rich link paste (text/html holds a single <a href>): normalize to [text](href).
  if (html.includes("<a")) {
    const link = singleAnchor(html);
    if (link) {
      const href = safeHref(link.href);
      if (!href) return null; // dangerous scheme → not a link; default paste (plain text)
      return `[${escLinkText(link.text || href)}](${emitHref(href)})`;
    }
  }
  // 2. Bare http/https URL paste. safeHref is the scheme gate (http/https pass; nothing dangerous linkifies).
  if (BARE_URL.test(text) && safeHref(text)) {
    const anchor = input.selectedText.trim() ? input.selectedText : text;
    return `[${escLinkText(anchor)}](${emitHref(text)})`;
  }
  return null;
}

// CM-body paste handler. Ctrl/Cmd+Shift+V requests a PLAIN paste (skip linkify once), the standard
// "paste without formatting" escape hatch. Reads text/plain + text/html; on a linkify hit, replaces the
// selection with the Markdown in ONE offset-invariant Y.Text edit (single Y.Text invariant).
export function pasteLinkify(): Extension {
  let plainNext = false;
  return EditorView.domEventHandlers({
    keydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "v" || e.key === "V")) plainNext = true;
      return false;
    },
    paste(e, view) {
      if (view.state.readOnly) return false;
      if (plainNext) { plainNext = false; return false; } // Ctrl+Shift+V → default (plain) paste
      const cd = e.clipboardData;
      if (!cd) return false;
      const sel = view.state.selection.main;
      const md = linkifyPaste({
        text: cd.getData("text/plain"),
        html: cd.getData("text/html"),
        selectedText: view.state.sliceDoc(sel.from, sel.to),
      });
      if (md == null) return false; // not a linkify case → let CM paste normally
      e.preventDefault();
      view.dispatch(view.state.replaceSelection(md), { scrollIntoView: true });
      return true;
    },
  });
}
