import { EditorView, minimalSetup } from "codemirror";
import { tooltips } from "@codemirror/view";
import { EditorState, type Compartment } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, livePreviewTheme, linkClicks, blockEntry, motionKeyTracker, vimEnabled, imageResolver, checkboxControl, type ImageResolver } from "./live-preview/decorations";
import { commentHighlights, commentHighlightTheme } from "./live-preview/comment-highlights";
import { floatingToolbar } from "./live-preview/toolbar";
import { slashPalette } from "./live-preview/palette";
import { contextMenu } from "./live-preview/context-menu";
import { vimExCommands } from "./live-preview/vim-ex";
import { macroFold, autoFoldLargeFenceMacros } from "./macros";
import { registerVimFold } from "./live-preview/vim-fold";
import { macroEdit } from "./live-preview/macro-edit";

// vim Compartment content: the keymap AND a vimEnabled flag (so the decoration builder
// can be mode-aware — ADR-022 Part 11). Reused by mount + the Editor's vim toggle.
export const vimCompartmentContent = (on: boolean) => (on ? [vim(), vimEnabled.of(true)] : [vimEnabled.of(false)]);

// Map vim za/zo/zc onto CodeMirror fold commands (codemirror-vim omits them) so vim
// users can fold macro blocks. Idempotent; runs once at module load.
registerVimFold();
import type { ImageUploader } from "./live-preview/commands";
import { attachImageDrop } from "./live-preview/image-drop";
import { cmTheme } from "../styles/cm-theme";
import { remoteCursors } from "./remote-cursors";

// The CodeMirror EditorView is built ONCE (a React effect that doesn't re-run on HMR),
// so hot-swapping this module would leave a STALE view running the old extensions (a
// fix to editor behaviour wouldn't take effect until a manual reload). Self-accept +
// reload so the running editor always reflects the latest code. Dev-only (stripped prod).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// The single editing surface (Group C / Step I): Obsidian-style live preview bound to
// the canonical Y.Text. Rendered by default; the line/block under the cursor reveals
// raw markdown (reveal-on-cursor in decorations.ts) so it's editable in place. vim is
// an OPTIONAL keymap toggled via a Compartment owned by the caller — toggling it
// reconfigures in place (never remounts), so collab/presence are never dropped (#8
// invariant). vim() goes FIRST so its keymap takes precedence; with vim OFF the
// compartment is empty (pure live preview).
export function mountLivePreview(
  parent: HTMLElement,
  ytext: Y.Text,
  provider: HocuspocusProvider,
  opts: { readOnly?: boolean; resolveImageUrl?: ImageResolver; uploadImage?: ImageUploader; vim?: boolean; vimCompartment?: Compartment; onExitEdit?: () => void; onPublish?: () => void } = {},
): EditorView {
  // minimalSetup (no line numbers/gutters — this is a reading-style surface).
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      ...(opts.vimCompartment ? [opts.vimCompartment.of(vimCompartmentContent(!!opts.vim))] : [vimEnabled.of(false)]),
      minimalSetup,
      // position:fixed so the palette/bubble/hint escape overflow:hidden ancestors and
      // CM flips them above/below + shifts horizontally to stay within the viewport.
      tooltips({ position: "fixed" }),
      cmTheme,
      EditorView.lineWrapping,
      // #6: the editing chrome floats OVER the editor's bottom (VIM toggle bottom-left,
      // ACTIONS bottom-right — PageControls, at `bottom-4`). This bottom scroll-margin keeps
      // the caret above that ~52px band: CM scrolls BEFORE the caret reaches it. The room to
      // lift the LAST line comes from `.lp-editor-host .cm-content { padding-bottom: 4.5rem }`
      // (tokens.css) — the two MUST stay in sync (72px ≈ 4.5rem).
      EditorView.scrollMargins.of(() => ({ bottom: 72 })),
      // GFM base (tables) + fenced-code highlighting. The doc stays plain markdown.
      markdownExtension(),
      livePreviewTheme,
      livePreview,
      // Macro blocks (ADR-022): code-fence macros (```mermaid) render via the registry;
      // folding collapses a block to its summary line (vim za/zo). Editable surface only
      // — the fold affordance is an editing control; the published view just renders.
      macroFold,
      // Inline macro edit state + Esc-exit (entered by clicking a macro — Part 11).
      macroEdit,
      // Task checkboxes are interactive on the editable surface: a click flips the
      // `[ ]`/`[x]` char directly in the Y.Text (a normal draft edit). (Read-only →
      // disabled; the view surface wires its own no-revision persist below.)
      ...(opts.readOnly ? [] : [checkboxControl.of({ mode: "edit" })]),
      // DEV-only probe: expose the caret's doc line + selection offsets so e2e can
      // assert motion / selection extent. Stripped from prod builds.
      ...(import.meta.env.DEV ? [EditorView.updateListener.of((u) => {
        if (!u.selectionSet) return;
        const s = u.state.selection.main;
        const w = window as Window & { __lpHeadLine?: number; __lpSel?: { from: number; to: number; head: number; anchor: number } };
        w.__lpHeadLine = u.state.doc.lineAt(s.head).number;
        w.__lpSel = { from: s.from, to: s.to, head: s.head, anchor: s.anchor };
      })] : []),
      linkClicks,
      // Redirect vertical motion into collapsed blocks so their source is reachable
      // line-by-line, and clamp overshoot past tall block widgets (editable only).
      ...(opts.readOnly ? [] : [motionKeyTracker, blockEntry]),
      // Inline-comment anchor highlights (display-only; fed via setCommentRanges).
      commentHighlightTheme,
      commentHighlights,
      // Resolves wks-attachment image ids → fresh presigned URLs (member only).
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      yCollab(ytext, provider.awareness),
      remoteCursors, // #8: avatar+name flags (additive overlay; yCollab untouched)
      // Slash command palette + floating selection toolbar (editable surface only; view
      // guests get neither). The `/` palette owns image insert (P): uploadImage + the
      // container (the host, so the hidden file input survives CM's DOM reconcile) go
      // here. The bubble is decoration-only (A). slashPalette FIRST so its vimVisualField
      // precedes the toolbar's bubble (which reads it to suppress itself in vim visual).
      ...(!opts.readOnly ? [slashPalette({ uploadImage: opts.uploadImage, container: parent }), floatingToolbar(), contextMenu(), vimExCommands({ exitEdit: opts.onExitEdit, publish: opts.onPublish })] : []),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // Drag-and-drop image attach (editable surface only — needs an uploader).
  if (!opts.readOnly && opts.uploadImage) attachImageDrop(view, opts.uploadImage);

  // Default large macro blocks to folded — ONCE, after the initial collab sync (the
  // doc is empty at mount; the content arrives over the provider). rAF so yCollab has
  // applied the synced doc to CM before we measure block sizes.
  if (!opts.readOnly) {
    let folded = false;
    const runAutoFold = () => { if (folded) return; folded = true; requestAnimationFrame(() => autoFoldLargeFenceMacros(view)); };
    if (provider.synced) runAutoFold();
    else provider.on("synced", runAutoFold);
  }

  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);

  return view;
}

// Read-only render of a page's PUBLISHED markdown (draft/publish model). Unlike
// mountLivePreview this is NOT collab-bound — view-capability users (and view share
// links) never join the collab room, so the live draft is never delivered to their
// browser; they only ever receive the published snapshot over HTTP. Same live-
// preview decorations + image resolver, no yCollab / comments / toolbar.
export function mountPublishedView(
  parent: HTMLElement,
  markdown: string,
  // onToggleTask (ADR-019): present only for an edit-capable viewer on a non-dirty page.
  // A checkbox click calls it; the host flips the live draft over its collab connection
  // and folds the flip into published_md via the no-revision endpoint. Absent → the
  // checkboxes render DISABLED (display only; the server is the bastion regardless).
  opts: { resolveImageUrl?: ImageResolver; onToggleTask?: (index: number, from: number, checked: boolean) => void } = {},
): EditorView {
  const view = new EditorView({
    doc: markdown,
    extensions: [
      minimalSetup,
      cmTheme,
      EditorView.lineWrapping,
      markdownExtension(),
      livePreviewTheme,
      livePreview,
      linkClicks,
      checkboxControl.of(opts.onToggleTask ? { mode: "view", onToggle: opts.onToggleTask } : null),
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ],
  });
  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);
  return view;
}
