import { EditorView, minimalSetup } from "codemirror";
import { tooltips, keymap } from "@codemirror/view";
import { EditorState, Prec, type Compartment } from "@codemirror/state";
import { vim, getCM } from "@replit/codemirror-vim";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, livePreviewTheme, linkClicks, blockEntry, motionKeyTracker, vimEnabled, displayMode, imageResolver, diagramRenderer, transcludeResolver, embedAllowlist, embedUrlPrompt, checkboxControl, enterMacroCommand, ephemeralCollab, macroPresence, macroPresencePlugin, type ImageResolver, type DiagramRenderer, type TranscludeResolver, type DisplayMode, type EphemeralCollabFactory, type MacroPresence, type EmbedUrlPrompt } from "./live-preview/decorations";
import { commentHighlights, commentHighlightTheme } from "./live-preview/comment-highlights";
import { listEditing } from "./live-preview/list-edit";
import { floatingToolbar } from "./live-preview/toolbar";
import { slashPalette, type PageEmbedPicker } from "./live-preview/palette";
import { contextMenu } from "./live-preview/context-menu";
import { vimExCommands } from "./live-preview/vim-ex";
import { macroFold } from "./macros";
import { registerVimFold } from "./live-preview/vim-fold";
import { atomDelete, atomYank } from "./live-preview/vim-atom";
import { blockDrag } from "./live-preview/block-drag";
import { m1Spike } from "./live-preview/m1-spike";
import { everforestHighlight } from "./everforest-highlight";
import { mathField } from "./live-preview/math";
import { macroEdit } from "./live-preview/macro-edit";

// vim Compartment content: the keymap AND a vimEnabled flag (so the decoration builder
// can be mode-aware — ADR-022 Part 11). Reused by mount + the Editor's vim toggle.
export const vimCompartmentContent = (on: boolean) => (on ? [vim(), vimEnabled.of(true)] : [vimEnabled.of(false)]);

// Display-mode Compartment content (ADR-056 / #164). Reused by mount + the Editor's mode toggle.
// Reading is READ-ONLY but stays EDITABLE-focusable (#165): it uses EditorState.readOnly (blocks doc
// edits; nothing reveals since rangeRevealed returns false under readOnly, and grips/checkbox toggles
// gate on state.readOnly so they go inert) — but NOT EditorView.editable.of(false). Making the view
// non-editable removed the contentDOM's focusability, which disabled the vim keymap AND did not come
// back when switching out of Reading (vim⟂mode invariant violated — #165 rebound). Keeping it editable
// + readOnly means vim NAVIGATION (j/k/scroll) still works in Reading while edits stay blocked, and
// vim fully survives Reading↔Live/Source. Live/Source are fully editable.
export const displayModeContent = (m: DisplayMode) =>
  m === "reading"
    ? [displayMode.of(m), EditorState.readOnly.of(true), EditorView.editable.of(true)]
    : [displayMode.of(m), EditorState.readOnly.of(false), EditorView.editable.of(true)];

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
  opts: { readOnly?: boolean; resolveImageUrl?: ImageResolver; renderDiagram?: DiagramRenderer; resolveTransclude?: TranscludeResolver; embedProviders?: readonly string[]; openPageEmbedPicker?: PageEmbedPicker; openEmbedUrlPrompt?: EmbedUrlPrompt; uploadImage?: ImageUploader; vim?: boolean; vimCompartment?: Compartment; displayMode?: DisplayMode; displayModeCompartment?: Compartment; onExitEdit?: () => void; onPublish?: () => void; ephemeralCollab?: EphemeralCollabFactory; macroPresence?: MacroPresence } = {},
): EditorView {
  // minimalSetup (no line numbers/gutters — this is a reading-style surface).
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      ...(opts.vimCompartment ? [opts.vimCompartment.of(vimCompartmentContent(!!opts.vim))] : [vimEnabled.of(false)]),
      // ADR-056 / #164: editor display mode (live/source/...) via a Compartment so the caller can
      // switch it in place (no remount → collab/presence untouched), like vim.
      ...(opts.displayModeCompartment ? [opts.displayModeCompartment.of(displayModeContent(opts.displayMode ?? "live"))] : [displayMode.of(opts.displayMode ?? "live")]),
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
      // #212 bounce 3: the header band is an absolute frosted overlay over the editor's TOP. CM's
      // scrollIntoView doesn't know about it, so Ctrl+Home / caret-on-line-1 would scroll line 1 flush to
      // the viewport top — UNDER the band. A top scroll-margin equal to the band height (--wks-band-h,
      // published by routes.tsx bandRef; inherited onto the CM DOM) keeps the caret below the band. 0 when
      // there is no band (var unset). Pairs with `.cm-content { padding-top: var(--wks-band-h) }`.
      EditorView.scrollMargins.of((view) => {
        const raw = getComputedStyle(view.dom).getPropertyValue("--wks-band-h").trim();
        const top = raw.endsWith("px") ? parseFloat(raw) : 0;
        return { top: Number.isFinite(top) ? top : 0, bottom: 72 };
      }),
      // GFM base (tables) + fenced-code highlighting. The doc stays plain markdown.
      markdownExtension(),
      // #158-C2: Everforest code highlighting (after minimalSetup's default → takes precedence).
      everforestHighlight,
      livePreviewTheme,
      livePreview,
      mathField, // #158-C3: KaTeX math ($…$ / $$…$$), reveal-on-cursor atoms
      // Macro blocks (ADR-022): code-fence macros (```mermaid) render via the registry;
      // folding collapses a block to its summary line (vim za/zo). Editable surface only
      // — the fold affordance is an editing control; the published view just renders.
      macroFold,
      // Inline macro edit state + Esc-exit (entered by clicking a macro — Part 11).
      macroEdit,
      // ADR-024: Ctrl+Enter "enters" the macro atom at the caret (modal / inline cell-edit
      // / source reveal). High prec so it beats vim's default Enter handling. event.key
      // "Enter" is JIS-safe. Mouse users enter by clicking (decorations MacroWidget).
      Prec.high(keymap.of([{ key: "Ctrl-Enter", run: enterMacroCommand }])),
      // #202: list-editing keys (Tab/Shift-Tab indent, Enter continuation) — editable surface only.
      ...(opts.readOnly ? [] : [listEditing]),
      // Task checkboxes are interactive on the editable surface: a click flips the
      // `[ ]`/`[x]` char directly in the Y.Text (a normal draft edit). (Read-only →
      // disabled; the view surface wires its own no-revision persist below.)
      ...(opts.readOnly ? [] : [checkboxControl.of({ mode: "edit" })]),
      // DEV-only probe: expose the caret's doc line + selection offsets so e2e can
      // assert motion / selection extent. Stripped from prod builds.
      ...(import.meta.env.DEV ? [EditorView.updateListener.of((u) => {
        const w = window as Window & { __lpHeadLine?: number; __lpHeadLineLog?: number[]; __lpSel?: { from: number; to: number; head: number; anchor: number }; __lpBlocks?: { fromLine: number; toLine: number }[]; __lpMathAtoms?: { fromLine: number; toLine: number }[]; __lpAtomic?: { fromLine: number; toLine: number }[]; __lpVimInsert?: boolean };
        if (u.selectionSet) {
          const s = u.state.selection.main;
          w.__lpHeadLine = u.state.doc.lineAt(s.head).number;
          w.__lpSel = { from: s.from, to: s.to, head: s.head, anchor: s.anchor };
          // #183 diagnosis: a rolling log of the caret's LINE across moves, so pressing j/k a few
          // times yields the exact transition sequence (e.g. [1,2,3,4,6] shows line 5 was skipped)
          // WITHOUT hand-noting each step. Bounded so it can't grow unbounded. (window.__lpHeadLineLog
          // = [] to reset before a measurement.)
          (w.__lpHeadLineLog ??= []).push(w.__lpHeadLine);
          if (w.__lpHeadLineLog.length > 60) w.__lpHeadLineLog.shift();
        }
        // vim mode (insert/normal): macro entry must land in vim NORMAL (ADR-024 — entering
        // a macro = the vim normal world; `i` then inserts). Lets a spec assert no forced insert.
        w.__lpVimInsert = !!getCM(u.view)?.state.vim?.insertMode;
        // Expose the atom block ranges (LINE numbers) so a trace can verify a macro's atom covers its
        // WHOLE fence, not just one line. #183: math ($$ display) atoms live in a SEPARATE field
        // (mathField) that blockEntry does NOT read (its motion model uses only livePreview.blocks) —
        // expose them separately so a device trace shows whether a skipped line sits at a MATH atom
        // (the likely root: blockEntry's atom model diverges from CM's real atomicRanges when math is present).
        const bs = u.state.field(livePreview, false)?.blocks ?? [];
        w.__lpBlocks = bs.map((b) => ({ fromLine: u.state.doc.lineAt(b.from).number, toLine: u.state.doc.lineAt(b.to).number }));
        const mathAtomic = u.state.field(mathField, false)?.atomic;
        const mathRanges: { fromLine: number; toLine: number }[] = [];
        mathAtomic?.between(0, u.state.doc.length, (from, to) => { mathRanges.push({ fromLine: u.state.doc.lineAt(from).number, toLine: u.state.doc.lineAt(to).number }); });
        w.__lpMathAtoms = mathRanges;
        // #141 bounce: dump the ATOMIC ranges (EditorView.atomicRanges = livePreview.atomic) by line, so a
        // device trace shows whether a warped line sits on an atomic range (e.g. a `:::` fence marker) —
        // the path blockEntry's motionAtomsForCaret does NOT touch (it filters livePreview.blocks only).
        const atomic = u.state.field(livePreview, false)?.atomic;
        const atomicRanges: { fromLine: number; toLine: number }[] = [];
        atomic?.between(0, u.state.doc.length, (from, to) => { atomicRanges.push({ fromLine: u.state.doc.lineAt(from).number, toLine: u.state.doc.lineAt(to).number }); });
        w.__lpAtomic = atomicRanges;
        // #141 bounce: the geometric top (px) of each line's start — so a device trace can see whether a
        // Live decoration COLLAPSES adjacent lines (equal/near-equal tops ⇒ moveVertically treats two
        // lines as one and j/k skips a line). Bounded to a small window around the caret to stay cheap.
        try {
          const cl = u.state.doc.lineAt(u.state.selection.main.head).number;
          const tops: { line: number; top: number | null }[] = [];
          for (let n = Math.max(1, cl - 4); n <= Math.min(u.state.doc.lines, cl + 4); n++) {
            const c = u.view.coordsAtPos(u.state.doc.line(n).from);
            tops.push({ line: n, top: c ? Math.round(c.top) : null });
          }
          (w as unknown as { __lpLineTops?: unknown }).__lpLineTops = tops;
        } catch { /* coords unavailable (not laid out) */ }
      })] : []),
      // M1 focus-delegation SPIKE (#153 / ADR-054) — DEV/e2e only, never in prod. Activated by the
      // literal token `@SPIKE@` in the doc. Strip from prod builds.
      ...(import.meta.env.DEV ? [m1Spike] : []),
      linkClicks,
      // ADR-024 atom motion: every block decoration is a single motion-stop — a one-line
      // key lands ON the atom, the next steps past it (macros stay rendered; non-macro
      // blocks reveal on landing). motionKeyTracker gates the overshoot clamp. Editable only.
      ...(opts.readOnly ? [] : [motionKeyTracker, blockEntry, atomDelete, atomYank]),
      // #84: a left-gutter grip per top-level block; drag it to reorder (one Yjs op).
      // Display-only gutter + drop indicator; editable surface only.
      ...(opts.readOnly ? [] : [blockDrag]),
      // Inline-comment anchor highlights (display-only; fed via setCommentRanges).
      commentHighlightTheme,
      commentHighlights,
      // Resolves wks-attachment image ids → fresh presigned URLs (member only).
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      // #140: host-mediated plantuml render (the macro never fetches — narrow host-API).
      ...(opts.renderDiagram ? [diagramRenderer.of(opts.renderDiagram)] : []),
      // #108: host-mediated transclude (the :::transclude macro never fetches — narrow host-API).
      ...(opts.resolveTransclude ? [transcludeResolver.of(opts.resolveTransclude)] : []),
      ...(opts.embedProviders ? [embedAllowlist.of(opts.embedProviders)] : []),
      // #210 bounce: host seam for the in-app :::embed-external URL modal (retarget button → modal, not window.prompt).
      ...(opts.openEmbedUrlPrompt ? [embedUrlPrompt.of(opts.openEmbedUrlPrompt)] : []),
      // #92: host ephemeral-collab seam for a collab-capable modal (excalidraw); {theme} stays narrow.
      ...(opts.ephemeralCollab ? [ephemeralCollab.of(opts.ephemeralCollab)] : []),
      // #92 presence: bridge "editing a macro's modal" onto the page awareness (badge at the anchor).
      ...(opts.macroPresence ? [macroPresence.of(opts.macroPresence), macroPresencePlugin] : []),
      yCollab(ytext, provider.awareness),
      remoteCursors, // #8: avatar+name flags (additive overlay; yCollab untouched)
      // Slash command palette + floating selection toolbar (editable surface only; view
      // guests get neither). The `/` palette owns image insert (P): uploadImage + the
      // container (the host, so the hidden file input survives CM's DOM reconcile) go
      // here. The bubble is decoration-only (A). slashPalette FIRST so its vimVisualField
      // precedes the toolbar's bubble (which reads it to suppress itself in vim visual).
      ...(!opts.readOnly ? [slashPalette({ uploadImage: opts.uploadImage, container: parent, openPageEmbedPicker: opts.openPageEmbedPicker }), floatingToolbar(), contextMenu(), vimExCommands({ exitEdit: opts.onExitEdit, publish: opts.onPublish })] : []),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // Drag-and-drop image attach (editable surface only — needs an uploader).
  if (!opts.readOnly && opts.uploadImage) attachImageDrop(view, opts.uploadImage);

  // No auto-fold on load: a macro is an atom and ALWAYS renders (ADR-024 / Stage 1b).
  // A large Excalidraw/mermaid body previously auto-folded to the "▶ summary" placeholder
  // and only rendered the figure once the cursor touched it — that contradicts the atom
  // model (rendered on open, never auto-reveal). Fold stays available as a COSMETIC manual
  // action (za / the fold button via `macroFold`), but is no longer applied automatically.

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
  opts: { resolveImageUrl?: ImageResolver; renderDiagram?: DiagramRenderer; resolveTransclude?: TranscludeResolver; embedProviders?: readonly string[]; onToggleTask?: (index: number, from: number, checked: boolean) => void } = {},
): EditorView {
  const view = new EditorView({
    doc: markdown,
    extensions: [
      minimalSetup,
      cmTheme,
      EditorView.lineWrapping,
      markdownExtension(),
      everforestHighlight, // #158-C2: same code highlighting on the read-only published view
      livePreviewTheme,
      livePreview,
      mathField, // #158-C3: KaTeX math ($…$ / $$…$$), reveal-on-cursor atoms
      linkClicks,
      checkboxControl.of(opts.onToggleTask ? { mode: "view", onToggle: opts.onToggleTask } : null),
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      ...(opts.renderDiagram ? [diagramRenderer.of(opts.renderDiagram)] : []),
      ...(opts.resolveTransclude ? [transcludeResolver.of(opts.resolveTransclude)] : []),
      ...(opts.embedProviders ? [embedAllowlist.of(opts.embedProviders)] : []),
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
