import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { safeHref } from "../macros/md-render";
import { vimEnabled } from "./decorations";

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

// CM-body paste handler. #223 comment 862: attached as a CAPTURE-phase listener on contentDOM (a ViewPlugin,
// like image-drop / atomYank) — NOT EditorView.domEventHandlers — so it runs BEFORE CodeMirror's own paste
// handling (and any other paste listener), which is the robustness fix for the reported "handler never fires
// on the real device" (something consuming paste first). Ctrl/Cmd+Shift+V requests a PLAIN paste (skip
// linkify once). On a linkify hit it replaces the selection in ONE offset-invariant Y.Text edit (single
// Y.Text) and stopImmediatePropagation so CM does not also paste. window.__wksPasteDebug records what the
// handler saw, so a real-device paste stays inspectable.
export function pasteLinkify(): Extension {
  return ViewPlugin.define((view) => {
    let plainNext = false;
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "v" || e.key === "V")) { plainNext = true; return; }
      // #223 comment 875: with vim ON, `<C-v>` is a vim command (blockwise-visual) — vim's keymap consumes the
      // Ctrl+V keydown and preventDefaults it, so the browser never fires the `paste` event and this plugin's
      // capture paste handler never runs (no linkify, and no paste at all). Ctrl+V is the universal system-paste
      // gesture, so take it back for paste: on a PLAIN Ctrl/Cmd+V (no shift/alt) while vim is enabled, stop the
      // keydown HERE (capture, before vim's keymap) WITHOUT preventDefault, so vim never converts it and the
      // browser proceeds to fire the native paste event → our paste handler linkifies. vim's blockwise-visual
      // stays reachable via <C-q> (codemirror-vim binds it to the same action). Vim OFF needs no interception
      // (CM has no Ctrl+V keydown binding; it pastes via the native paste event, which we already intercept).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V") && view.state.facet(vimEnabled)) {
        e.stopImmediatePropagation();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      const dbg: Record<string, unknown> = {
        fired: true, readOnly: view.state.readOnly, plainNext, hasClipboardData: !!cd, phase: "capture",
        types: cd ? Array.from(cd.types) : [], plain: cd?.getData("text/plain"), htmlLen: cd?.getData("text/html")?.length ?? 0,
      };
      try { (window as unknown as { __wksPasteDebug?: unknown }).__wksPasteDebug = dbg; } catch { /* diag only */ }
      if (view.state.readOnly) { dbg.result = "skip:readOnly"; return; }
      if (plainNext) { plainNext = false; dbg.result = "skip:plainNext(Ctrl+Shift+V)"; return; }
      if (!cd) { dbg.result = "skip:noClipboardData"; return; }
      const sel = view.state.selection.main;
      const md = linkifyPaste({
        text: cd.getData("text/plain"),
        html: cd.getData("text/html"),
        selectedText: view.state.sliceDoc(sel.from, sel.to),
      });
      dbg.linkifyResult = md;
      if (md == null) { dbg.result = "no-linkify:default-paste"; return; } // not a linkify case → CM pastes
      e.preventDefault();
      e.stopImmediatePropagation(); // capture phase → keep CM's own paste from also running
      view.dispatch(view.state.replaceSelection(md), { scrollIntoView: true });
      dbg.result = "linkified:inserted";
    };
    view.contentDOM.addEventListener("keydown", onKeydown, true);
    view.contentDOM.addEventListener("paste", onPaste, true); // capture: before CodeMirror's own paste
    return {
      destroy() {
        view.contentDOM.removeEventListener("keydown", onKeydown, true);
        view.contentDOM.removeEventListener("paste", onPaste, true);
      },
    };
  });
}
