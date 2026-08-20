import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { getCM } from "@replit/codemirror-vim";
import { safeHref } from "../macros/md-render";
import { linkAt, linksTouching } from "./link-at"; // #611: THE structural link judge (ADR-211 §1)
import { completeBlockChunk, blockPasteInsert } from "./block-paste";
import { innermostMacroAt } from "./decorations";

// #223 / ADR-none (rides on ADR-037 + safeHref): auto-linkify a pasted URL / rich link into Markdown
// `[text](url)`, so the source stays plain Markdown (Open formats) while the live preview shows it clickable.
// The SAME `safeHref` is the ONLY scheme judgment (no new XSS boundary): a javascript:/data:/vbscript:/file:
// href is never linkified (falls back to a plain-text paste). Rich HTML (text/html) is read via DOMParser —
// NEVER innerHTML on a live node — and only the anchor's href (safeHref'd) + textContent are used.

const BARE_URL = /^https?:\/\/\S+$/i; // v1: explicit http/https scheme only (www./scheme-less → plain paste)

// Escape the Markdown link syntax so pasted text can't break out of `[...]` / `(...)`.
// Exported for #323 (the page-link insert escapes the picked page TITLE the same way).
export const escLinkText = (s: string): string => s.replace(/[[\]\\]/g, "\\$&");
const emitHref = (url: string): string => (/[()\s]/.test(url) ? `<${url}>` : url); // angle-wrap if it has ()/space

// The pasted HTML is a SINGLE link whose visible text is the whole paste → its href + text (else null).
// DOMParser.parseFromString does not execute scripts and builds an inert tree; we read attributes/textContent
// only (no innerHTML, no live DOM). Returns null when the paste is more than just one link (don't mangle it).
// #223 comment 885: match BOTH a real `<a href>` (external sites) AND our own rendered link, which is a
// `<span class="cm-lp-link" data-href>` (decorations.ts) — copying a link shown inside the editor yields the
// span, not an `<a>`, so without data-href it fell through to a plain-text paste.
function singleLink(html: string): { href: string; text: string } | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  const links = doc.querySelectorAll("a[href], [data-href]");
  if (links.length !== 1) return null;
  const el = links[0]!;
  const bodyText = (doc.body.textContent ?? "").trim();
  const elText = (el.textContent ?? "").trim();
  if (!bodyText || bodyText !== elText) return null; // extra content around the link → leave it to default paste
  return { href: el.getAttribute("href") ?? el.getAttribute("data-href") ?? "", text: elText };
}

// Pure decision: the Markdown to INSERT (replacing the current selection), or null to fall back to the
// editor's default paste. `selectedText` is the text the paste replaces (wrapped as the link anchor for a
// bare-URL paste, the "paste a link onto selected text" convention).
export function linkifyPaste(input: { text: string; html: string; selectedText: string }): string | null {
  const text = (input.text ?? "").trim();
  const html = input.html ?? "";
  // 1. Rich link paste (text/html holds a single <a href> or a cm-lp-link [data-href] span): normalize to
  // [text](href). #223 comment 885: also trigger on data-href so an in-editor link copy is caught.
  if (html.includes("<a") || html.includes("data-href")) {
    const link = singleLink(html);
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
// #223 comment 895 (root cause A, pure + testable): if [from,to] intersects any Link node, EXPAND to whole links
// and return the complete Markdown source (so a copy over a rendered `[hoge](url)` yields the full source,
// not the `hoge](` fragment CM's raw-slice copy produced). For a clean single-link selection, also return a
// safeHref-gated `<a>` HTML (createElement, never innerHTML). Returns null when no link is touched.
export function linkCopyRange(
  state: EditorState,
  selFrom: number,
  selTo: number,
): { from: number; to: number; plain: string; html?: string } | null {
  // #611 / ADR-211 §1: this used to be the second hand-rolled tree walk — it now reads the ONE judge.
  const hits = linksTouching(state, selFrom, selTo);
  if (hits.length === 0) return null;
  const from = Math.min(selFrom, hits[0]!.from);
  const to = Math.max(selTo, hits[hits.length - 1]!.to);
  const links = hits.length;
  const only: { from: number; to: number } | null = links === 1 ? { from: hits[0]!.from, to: hits[0]!.to } : null;
  const plain = state.sliceDoc(from, to);
  let html: string | undefined;
  if (links === 1 && only && (only as { from: number; to: number }).from === from && (only as { from: number; to: number }).to === to) {
    const m = /^\[([^\]]*)\]\(\s*<?([^)>\s]*)>?[^)]*\)$/.exec(plain);
    const href = m ? safeHref(m[2]!) : null;
    if (m && href) {
      const a = document.createElement("a"); // createElement, never innerHTML (ADR-037)
      a.setAttribute("href", href);
      a.textContent = m[1]!;
      html = a.outerHTML;
    }
  }
  return { from, to, plain, html };
}

export function pasteLinkify(): Extension {
  return ViewPlugin.define((view) => {
    let plainNext = false;
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "v" || e.key === "V")) { plainNext = true; return; }
      // #223 comment 946 (requirement change): only take Ctrl+V back from vim in INSERT mode. In vim
      // insert mode Ctrl+V should paste (and linkify) — vim doesn't bind it there, but we intercept before
      // any handler to guarantee the native paste event fires. In NORMAL / VISUAL mode Ctrl+V stays vim's
      // blockwise-visual (the earlier 879 behaviour of stealing it in every mode is reverted; normal-mode
      // paste is the vim `p` register's job, tracked in #225). Vim OFF needs no interception (CM has no
      // Ctrl+V keydown binding; it pastes via the native paste event, which we already intercept).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V") && getCM(view)?.state.vim?.insertMode) {
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
      // #223 comment 885/910 (root cause D): only BYPASS this body handler when a NESTED ISLAND actually holds focus
      // (a table widget or an in-cell contenteditable) — that island has its own paste handler, and inserting
      // at view.state.selection.main would drop the paste at the atom boundary (ADR-024). Comment 888's guard
      // `activeElement !== contentDOM` was too broad: a right-click / context-menu paste can leave
      // activeElement as the BODY or null (focus off contentDOM but NOT in an island), which then skipped
      // linkify. Precise check: bypass only when activeElement is inside a nested editable island.
      const ae = document.activeElement as HTMLElement | null;
      dbg.activeElement = ae ? `${ae.tagName}.${ae.className}`.slice(0, 80) : null;
      const inNestedIsland = !!ae && ae !== view.contentDOM && !!ae.closest?.(".cm-lp-table, [data-testid=table-edit], .cm-lp-nested-edit-island, .cm-lp-slot-edit-island");
      if (inNestedIsland) { dbg.result = "skip:nested-focus"; return; }
      const sel = view.state.selection.main;
      // #558: a COMPLETE block chunk (what #549's atomClipboard copies) pasted at an empty caret is
      // normalized to a line boundary — the natural follow-up to "click → Ctrl+C the whole block" is
      // pasting it next door, and the atom-edge caret sits mid-marker-line where a raw splice breaks
      // the notation (measured: "`````mermaid"). Ordinary text and range pastes fall through untouched.
      if (sel.empty) {
        const chunk = completeBlockChunk(cd.getData("text/plain") ?? "");
        if (chunk != null) {
          const doc = view.state.doc;
          const m = innermostMacroAt(view.state, sel.head);
          const block = m
            ? { fromLineFrom: doc.lineAt(m.from).from, toLineTo: doc.lineAt(Math.min(m.to, doc.length)).to }
            : null;
          const line = doc.lineAt(sel.head);
          const ins = blockPasteInsert(chunk, sel.head, { from: line.from, to: line.to }, block);
          e.preventDefault();
          e.stopImmediatePropagation(); // capture phase → CM's own paste must not also splice it in
          view.dispatch({
            changes: { from: ins.at, to: ins.at, insert: ins.insert },
            selection: { anchor: Math.min(ins.cursor, doc.length + ins.insert.length) },
            userEvent: "input.paste",
            scrollIntoView: true,
          });
          dbg.result = "block-paste:line-boundary";
          return;
        }
      }
      const md = linkifyPaste({
        text: cd.getData("text/plain"),
        html: cd.getData("text/html"),
        selectedText: view.state.sliceDoc(sel.from, sel.to),
      });
      dbg.linkifyResult = md;
      if (md == null) { dbg.result = "no-linkify:default-paste"; return; } // not a linkify case → CM pastes
      e.preventDefault();
      e.stopImmediatePropagation(); // capture phase → keep CM's own paste from also running
      // #611 / ADR-211 §3: pasting a URL over a selection INSIDE an existing link used to wrap a second
      // link around part of the first — `[a[b](u2)](u1)` — and this is the most reachable nesting path
      // (Ctrl+V a URL in WYSIWYG). The shared judge decides: inside a link, the paste becomes "replace
      // THAT link's URL" — an edit, not a wrap. The plain-text linkify fast-path is unchanged.
      const hit = linkAt(view.state, sel.from, sel.to);
      if (hit && hit.hasUrl) {
        const pastedUrl = /\]\(([^)]*)\)$/.exec(md)?.[1];
        if (pastedUrl) {
          view.dispatch({
            changes: { from: hit.urlFrom, to: hit.urlTo, insert: pastedUrl },
            selection: { anchor: hit.urlFrom + pastedUrl.length },
            userEvent: "input.paste",
            scrollIntoView: true,
          });
          dbg.result = "linkified:retargeted-existing-link";
          return;
        }
      }
      view.dispatch(view.state.replaceSelection(md), { scrollIntoView: true });
      dbg.result = "linkified:inserted";
    };
    // #223 comment 895 (root cause A — the actual fix is on the COPY side): CodeMirror's own copy/cut only sets
    // text/plain, and its value is the raw doc slice of the SELECTION — which, over a rendered `[hoge](url)`
    // link, maps to a doc range that CUTS THROUGH the hidden `[` / `](url)` markers, so copying a link yields
    // a fragment like `hoge](`. Fix it at the source: on copy/cut, if the selection intersects a Link node,
    // EXPAND the copied range to whole links and set text/plain to that complete Markdown source. Also set
    // text/html to a real `<a href>` (createElement, href via safeHref — the SAME single scheme judge, no new
    // XSS boundary) when the expanded selection is exactly ONE link, so pasting into an external app (or back
    // here) yields a rich link. Capture phase so it beats CM's own copy handler.
    const onCopyOrCut = (e: ClipboardEvent) => {
      const isCut = e.type === "cut";
      if (isCut && view.state.readOnly) return;
      const sel = view.state.selection.main;
      if (sel.empty || !e.clipboardData) return;
      const copy = linkCopyRange(view.state, sel.from, sel.to);
      if (!copy) return; // no link touched → let CM copy the selection normally
      e.clipboardData.setData("text/plain", copy.plain);
      if (copy.html) e.clipboardData.setData("text/html", copy.html);
      e.preventDefault();
      if (isCut) view.dispatch({ changes: { from: copy.from, to: copy.to, insert: "" }, scrollIntoView: true });
    };
    view.contentDOM.addEventListener("keydown", onKeydown, true);
    view.contentDOM.addEventListener("paste", onPaste, true); // capture: before CodeMirror's own paste
    view.contentDOM.addEventListener("copy", onCopyOrCut, true); // capture: before CM's own copy
    view.contentDOM.addEventListener("cut", onCopyOrCut, true);
    return {
      destroy() {
        view.contentDOM.removeEventListener("keydown", onKeydown, true);
        view.contentDOM.removeEventListener("paste", onPaste, true);
        view.contentDOM.removeEventListener("copy", onCopyOrCut, true);
        view.contentDOM.removeEventListener("cut", onCopyOrCut, true);
      },
    };
  });
}
