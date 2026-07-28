import { EditorView, minimalSetup } from "codemirror";
import { dropCursor } from "@codemirror/view";
import { tooltips, keymap } from "@codemirror/view";
import { EditorState, Prec, type Compartment, type Extension } from "@codemirror/state";
import { vim, getCM } from "@replit/codemirror-vim";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, selectionTouched, reAnchorAfterReveal, atomClipboard, atomSelectionTint, livePreviewTheme, linkClicks, blockEntry, wysiwygInlineSkip, motionKeyTracker, vimEnabled, displayMode, imageResolver, attachmentResolver, diagramRenderer, transcludeResolver, listSource, linkStatusResolver, embedAllowlist, embedUrlPrompt, tagSuggestSource, tagPrompt, checkboxControl, enterMacroCommand, nestedDeleteChange, ephemeralCollab, macroPresence, coEditHost, nestedLivePreviewConfig, type ImageResolver, type AttachmentResolver, type DiagramRenderer, type TranscludeResolver, type ListSource, type LinkStatusResolver, type DisplayMode, type EphemeralCollabFactory, type MacroPresence, type CoEditHost, type EmbedUrlPrompt, type TagSuggestSource, type TagPrompt } from "./live-preview/decorations";
import { deadLinks } from "./live-preview/dead-links"; // #276 / ADR-117: dead-internal-link strikethrough overlay
import { blockAnchors } from "./live-preview/block-anchor"; // #325 / ADR-137 slice 2: hide trailing ` ^id` markers
import { commentHighlights, commentHighlightTheme } from "./live-preview/comment-highlights";
import { listEditing } from "./live-preview/list-edit";
import { pasteLinkify } from "./live-preview/paste-linkify";
import { titleLinkDecorations, titleLinkHover, titleLinkSource, type TitleLinkSource } from "./live-preview/title-links-deco";
import { floatingToolbar } from "./live-preview/toolbar";
import { slashPalette, type PageEmbedPicker, type TemplateInsertPicker } from "./live-preview/palette";
import { contextMenu } from "./live-preview/context-menu";
import { codeFenceSettingsPanel } from "./live-preview/fence-settings-panel"; // #456 S4/declared code-fence settings (panel + keyboard opener + hover ✎), in CM's tooltip layer
import { vimExCommands } from "./live-preview/vim-ex";
import { macroFold } from "./macros";
import { registerVimFold } from "./live-preview/vim-fold";
import { registerVimHalfPage } from "./live-preview/vim-halfpage";
import { atomDelete, atomYank, vimWysiwygCaretGuard } from "./live-preview/vim-atom";
import { blockDrag } from "./live-preview/block-drag";
import { everforestHighlight } from "./everforest-highlight";
import { mathField } from "./live-preview/math";
import { macroEdit, nestedSelectionField, setNestedSelection } from "./live-preview/macro-edit";
import { headingAnchors } from "./live-preview/heading-anchor"; // #313: hover 🔗 per heading line
import { search, searchKeymap } from "@codemirror/search"; // #402: in-page find & replace (non-vim + Reading)

// vim Compartment content: the keymap AND a vimEnabled flag (so the decoration builder
// can be mode-aware — ADR-022 Part 11). Reused by mount + the Editor's vim toggle.
// #402the CM search panel speaks through EditorState.phrases — the host passes a translated
// map (built from i18n in Editor.tsx) and owns a Compartment so a LANGUAGE TOGGLE reconfigures the
// phrases in place (vim/displayMode-style — never a remount, collab/presence untouched). No map = CM's
// built-in English.
export const searchPhrasesContent = (map: Record<string, string> | undefined): Extension =>
  map ? EditorState.phrases.of(map) : [];

// #402: the NON-vim branch carries the find/replace keymap (Mod-f / F3 / Mod-g). Vim keeps its own `/`
// and ex `:%s` — mounting the CM panel keymap under vim would fight its bindings. Living inside the SAME
// Compartment, a vim toggle swaps keymaps in place (never re-mounts → collab/presence stay attached).
export const vimCompartmentContent = (on: boolean) =>
  (on ? [vim(), vimEnabled.of(true)] : [vimEnabled.of(false), keymap.of(searchKeymap)]);

// Display-mode Compartment content (ADR-056 / #164). Reused by mount + the Editor's mode toggle.
// Reading is READ-ONLY but stays EDITABLE-focusable (#165): it uses EditorState.readOnly (blocks doc
// edits; nothing reveals since rangeRevealed returns false under readOnly, and grips gate on
// state.readOnly so they go inert — task checkboxes stay LIVE though (#314): Reading's invariant is
// "no prose editing", and the task toggle is an allowed read-surface operation, ADR-019, same as the
// published view surface) — but NOT EditorView.editable.of(false). Making the view
// non-editable removed the contentDOM's focusability, which disabled the vim keymap AND did not come
// back when switching out of Reading (vim⟂mode invariant violated — #165 rebound). Keeping it editable
// + readOnly means vim NAVIGATION (j/k/scroll) still works in Reading while edits stay blocked, and
// vim fully survives Reading↔Live/Source. Live/Source are fully editable.
export const displayModeContent = (m: DisplayMode) =>
  m === "reading"
    // #488no dropCursor in Reading — the mode is read-only (below), so a file cannot drop here
    // and a cursor would be an affordance for nothing. minimalSetup omits dropCursor, so absence = off.
    ? [displayMode.of(m), EditorState.readOnly.of(true), EditorView.editable.of(true)]
    // #488: the drop cursor draws at the same posAtCoords the drop lands on (image-drop.ts). Display-only
    // (a div on scrollDOM; no doc/offset change). It rides the mode compartment so it is present exactly
    // when editing is, and vanishes on the switch to Reading in lockstep with EditorState.readOnly.
    : [displayMode.of(m), EditorState.readOnly.of(false), EditorView.editable.of(true), dropCursor()];

// Map vim za/zo/zc onto CodeMirror fold commands (codemirror-vim omits them) so vim
// users can fold macro blocks. Idempotent; runs once at module load.
registerVimFold();
// #526: replace codemirror-vim's <C-d>/<C-u>, which WRAP at the document ends (Ctrl-D on the last line
// jumps the caret to offset 0), with a clamped half-page motion. Idempotent; runs once at module load.
registerVimHalfPage();

import type { ImageUploader } from "./live-preview/commands";
import { attachFileDrop } from "./live-preview/image-drop";
import { cmTheme } from "../styles/cm-theme";
import { remoteCursors } from "./remote-cursors";
import { macroPresenceOverlay, macroPresencePublisher } from "./macro-presence-overlay";
import { affordanceLayout } from "./live-preview/affordance-layout";

// The CodeMirror EditorView is built ONCE (a React effect that doesn't re-run on HMR),
// so hot-swapping this module would leave a STALE view running the old extensions (a
// fix to editor behaviour wouldn't take effect until a manual reload). Self-accept +
// reload so the running editor always reflects the latest code. Dev-only (stripped prod).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// The header band is an absolute frosted overlay over the editor's TOP (#212); its height is published
// as --wks-band-h (routes.tsx bandRef, inherited onto the CM DOM). 0 when there is no band (var unset).
// Read by the scrollMargins provider AND the #306 scrolloff (which must subtract it) — keep them in sync.
function headerBandPx(view: EditorView): number {
  const raw = getComputedStyle(view.dom).getPropertyValue("--wks-band-h").trim();
  const px = raw.endsWith("px") ? parseFloat(raw) : 0;
  return Number.isFinite(px) ? px : 0;
}

// The band/controls scrollIntoView clearance, shared by BOTH surfaces (#212 bounce 3 / #6): top =
// the frosted band's real height, bottom = the floating controls strip (72px ≈ the .cm-content
// 4.5rem padding-bottom — keep in sync). #313: the read-only published view needs it too, else a
// TOC/anchor jump lands the heading flush under the band.
// #473: the most the scrolloff may close the gap by, beyond the caret's own movement, in one keypress.
// Half a line — visible as the view catching up, not as the caret jumping.
const CATCH_UP_PX = 12;
const bandScrollMargins = EditorView.scrollMargins.of((view) => ({ top: headerBandPx(view), bottom: 72 }));

// ADR-122 addendum (b) / #278: the options consumed by the SHARED decoration/keymap layer (layer i) —
// the subset of the mount options that configure rendering/editing behaviour, as opposed to collab/
// presence (layer ii) or host chrome (layer iii). buildLivePreviewExtensions reads only these.
export interface LivePreviewSharedOpts {
  readOnly?: boolean;
  /** #549: the page id for the context menu's block-reference entry (outer surface only). */
  selfPageId?: string;
  resolveImageUrl?: ImageResolver;
  resolveAttachment?: AttachmentResolver;
  renderDiagram?: DiagramRenderer;
  resolveTransclude?: TranscludeResolver;
  embedProviders?: readonly string[];
  openPageEmbedPicker?: PageEmbedPicker;
  openEmbedUrlPrompt?: EmbedUrlPrompt;
  tagSuggest?: TagSuggestSource; // #413: view-filtered tag suggestions (member surfaces)
  openTagPrompt?: TagPrompt; // #413: the :::tagged tag picker
  openTemplateInsertPicker?: TemplateInsertPicker;
  uploadImage?: ImageUploader;
  titleLinks?: TitleLinkSource;
  list?: ListSource;
  linkStatus?: LinkStatusResolver;
  searchPhrases?: Record<string, string>; // #402translated CM search-panel phrases
}

// ADR-122 addendum (b) / #278: how the shared layer is being mounted. `nested: true` = a nested markdown
// editor (the slot-edit island): page-structure affordances (block drag) and host action seams (image
// upload / pickers on the slash palette) are dropped, and vim/displayMode are pinned as static facets —
// the island is short-lived and remounts, while the OUTER surface owns them via Compartments instead
// (so a toggle reconfigures in place and never drops collab/presence).
export interface LivePreviewLayerEnv {
  nested: boolean;
  vim?: boolean;
  displayMode?: DisplayMode;
  container?: HTMLElement; // the slash palette's stable DOM host (outer surface only)
}

// The live-preview DECORATION/KEYMAP layer (ADR-122 addendum (b)): built by ONE factory and shared
// verbatim between the outer editing surface and any nested markdown editor (the slot island), so the
// island's reveal / vim-atom / WYSIWYG marker-hide / nested-macro render can never drift from the outer
// surface (the per-nested "manual facet mirror" this replaces was the whack-a-mole source,).
//
// This is layer (i) ONLY. Deliberately NOT here:
//   (ii) collab/presence — yCollab / ephemeralCollab / macroPresence. A nested mount must NEVER carry
//        these: a second live binding to the canonical Y.Text is the echo-loop / dual-CRDT the single-
//        Y.Text invariant forbids (the island writes via commit-on-blur replaceSource, ADR-025).
//   (iii) host integration — floating toolbar / context menu / vim ex-commands / file drop / the dev
//        probe: page-surface chrome, wrong inside a nested cell.
// The outer mount adds (ii)+(iii) itself; the island gets this factory via nestedLivePreviewConfig.
export function buildLivePreviewExtensions(opts: LivePreviewSharedOpts, env: LivePreviewLayerEnv): Extension {
  const readOnly = env.nested ? false : !!opts.readOnly; // the island only ever mounts on an editable surface (the click gate refuses Reading/readOnly)
  return [
    // Nested mounts pin vim/displayMode for the island's lifetime (no Compartments — see LivePreviewLayerEnv).
    // Reading never reaches an island and Source containers never render widgets, so only live/wysiwyg apply.
    ...(env.nested ? [vimEnabled.of(!!env.vim), displayMode.of(env.displayMode ?? "live")] : []),
    // #286: minimalSetup omits allowMultipleSelections (basicSetup includes it). Without it, vim's
    // blockwise visual (Ctrl+V) — which codemirror-vim implements as one selection RANGE per line — has
    // its extra ranges collapsed to the main one, so a rectangle selects only the caret line. Enable it so
    // the block selection survives; drawSelection (in minimalSetup) already renders every range. This is
    // LOCAL, display-only selection state — the single-Y.Text doc / remote presence are untouched.
    EditorState.allowMultipleSelections.of(true),
    // GFM base (tables) + fenced-code highlighting. The doc stays plain markdown.
    markdownExtension(),
    // #158-C2: Everforest code highlighting (after minimalSetup's default → takes precedence).
    everforestHighlight,
    livePreviewTheme,
    livePreview,
    // #543: tracks whether a selection has ever been SET (vs the mount default nobody chose) — the
    // reveal predicates consult it so a surface whose doc starts with a construct does not open with
    // that construct's raw markers exposed. Registered here so islands (nested factory) carry it too.
    selectionTouched,
    // #528 / ADR-192: the ONE owner that places every block affordance (✎ chrome row, raw rich-edit pill,
    // presence box). They used to claim the same corner from three different offset parents, so whichever
    // two were visible together overlapped; the owner measures them all against one origin and resolves the
    // set. Measure-phase only — it never dispatches (the #92 presence-safety rule).
    affordanceLayout,
    // #243: re-anchor the caret after a revealed diagram re-mounts as an atom and settles taller
    // (async SVG), so leaving a mermaid/plantuml block by `j` never pushes the caret off-screen. Editable
    // surface only — the read-only view never reveals macros (no caret-in), so the transition can't occur.
    reAnchorAfterReveal,
    mathField, // #158-C3: KaTeX math ($…$ / $$…$$), reveal-on-cursor atoms
    // Macro blocks (ADR-022): code-fence macros (```mermaid) render via the registry;
    // folding collapses a block to its summary line (vim za/zo). Editable surface only
    // — the fold affordance is an editing control; the published view just renders.
    macroFold,
    // Inline macro edit state + Esc-exit (entered by clicking a macro — Part 11).
    macroEdit,
    // #359symptom 3: empty-caret copy/cut on a block atom takes the whole block's source (CM's
    // line-copy default emitted a broken first-line fragment). Shared with the islands via this factory.
    atomClipboard,
    atomSelectionTint, // #359visual-selection tint on crossed atoms
    // ADR-024: Ctrl+Enter "enters" the macro atom at the caret (modal / inline cell-edit
    // / source reveal). High prec so it beats vim's default Enter handling. event.key
    // "Enter" is JIS-safe. Mouse users enter by clicking (decorations MacroWidget).
    Prec.high(keymap.of([{ key: "Ctrl-Enter", run: enterMacroCommand }])),
    // #215 / ADR-100 (Consumer 4): with a nested macro selected, Backspace/Delete remove ONLY its range
    // (one Y.Text change via nestedDeleteChange — the same range vim `dd` uses). Falls through (returns
    // false) when nothing nested is selected, so normal Backspace/Delete is untouched everywhere else.
    ...(readOnly ? [] : [Prec.high(keymap.of((["Backspace", "Delete"]).map((key) => ({ key, run: (view) => {
      const sel = view.state.field(nestedSelectionField, false);
      if (!sel) return false;
      const ch = nestedDeleteChange(view.state, sel.anchor);
      if (!ch) return false;
      view.dispatch({ changes: ch, effects: setNestedSelection.of(null), userEvent: "delete" });
      view.focus();
      return true;
    } })))) ]),
    // #202: list-editing keys (Tab/Shift-Tab indent, Enter continuation) — editable surface only.
    ...(readOnly ? [] : [listEditing]),
    // #549: the right-click menu is part of the SHARED surface — a slot island without it had its
    // right-clicks bubble to the OUTER editor, whose menu then acted on the outer doc at the container
    // boundary ("Copy block" took the whole container). Island-local mounting gives island-local
    // resolution for free. Block references stay an outer-surface affordance (the island's doc is a
    // temporary slice; a marker written there only lands on commit, and the entry's page-id anchor
    // semantics are defined on the page surface).
    ...(readOnly ? [] : [contextMenu({ selfPageId: env.nested ? undefined : opts.selfPageId })]),
    // #223: paste a URL / rich link → Markdown [text](url) (editable surface only; Ctrl+Shift+V pastes plain).
    ...(readOnly ? [] : [pasteLinkify()]),
    // #224 / ADR-104: auto internal links. The decoration plugin is always present but INERT until the host
    // injects `titleLinks` — a dictionary already filtered to the viewer's authorized pages (the authz lives
    // there, not here) plus a navigate callback that re-confirms `view` at the destination. No source → no
    // dictionary → no links (safe default), so mounting it unconditionally never leaks.
    titleLinkDecorations(),
    titleLinkHover(), // #224: the excerpt hover card (tooltip layer) — inert without a source/excerpt seam
    ...(opts.titleLinks ? [titleLinkSource.of(opts.titleLinks)] : []),
    // Task checkboxes are interactive on the editable surface: a click flips the
    // `[ ]`/`[x]` char directly in the doc (in a slot island: the ISLAND doc, committed on blur).
    ...(readOnly ? [] : [checkboxControl.of({ mode: "edit" })]),
    linkClicks,
    // ADR-024 atom motion: every block decoration is a single motion-stop — a one-line
    // key lands ON the atom, the next steps past it (macros stay rendered; non-macro
    // blocks reveal on landing). motionKeyTracker gates the overshoot clamp. Editable only.
    ...(readOnly ? [] : [motionKeyTracker, blockEntry, wysiwygInlineSkip, atomDelete, atomYank, vimWysiwygCaretGuard]),
    // #84: a left-gutter grip per top-level block; drag it to reorder (one Yjs op). Display-only gutter +
    // drop indicator; editable surface only. NOT in a nested island — block reorder is a page-structure
    // affordance, and a drag crossing the island boundary has no defined target.
    ...(readOnly || env.nested ? [] : [blockDrag]),
    // #313: hover 🔗 on heading lines — copies the heading's anchor URL (display-only widget).
    headingAnchors,
    // Inline-comment anchor highlights (display-only; fed via setCommentRanges — inert without data).
    commentHighlightTheme,
    commentHighlights,
    // Resolves wks-attachment image ids → fresh presigned URLs (member only).
    ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
    // #273: resolves [name](wks-attachment:id) file links -> chip / download card / inline viewer.
    ...(opts.resolveAttachment ? [attachmentResolver.of(opts.resolveAttachment)] : []),
    // #140: host-mediated plantuml render (the macro never fetches — narrow host-API).
    ...(opts.renderDiagram ? [diagramRenderer.of(opts.renderDiagram)] : []),
    // #108: host-mediated transclude (the :::transclude macro never fetches — narrow host-API).
    ...(opts.resolveTransclude ? [transcludeResolver.of(opts.resolveTransclude)] : []),
    ...(opts.list ? [listSource.of(opts.list)] : []), // #370 / ADR-145: host-mediated :::tagged / :::children (member-only)
    deadLinks, // #276 / ADR-117: dead-internal-link strikethrough (inert without the linkStatus seam)
    blockAnchors, // #325 / ADR-137 slice 2: hide trailing ` ^id` block-ref markers (reveal on the caret line)
    ...(opts.linkStatus ? [linkStatusResolver.of(opts.linkStatus)] : []),
    ...(opts.embedProviders ? [embedAllowlist.of(opts.embedProviders)] : []),
    // #210 bounce: host seam for the in-app :::embed-external URL modal (retarget button → modal, not window.prompt).
    ...(opts.openEmbedUrlPrompt ? [embedUrlPrompt.of(opts.openEmbedUrlPrompt)] : []),
    ...(opts.tagSuggest ? [tagSuggestSource.of(opts.tagSuggest)] : []), // #413
    ...(opts.openTagPrompt ? [tagPrompt.of(opts.openTagPrompt)] : []), // #413
    search({ top: true }), // #402: find/replace panel config (opened by the non-vim keymap above)
    // #402nested islands take the phrases statically (they are short-lived); the OUTER surface
    // provides them via its Compartment in mountLivePreview/mountPublishedView instead (toggle-follows).
    ...(env.nested ? [searchPhrasesContent(opts.searchPhrases)] : []),
    // Slash command palette (editable surface only; view guests don't get it). The `/` palette owns image
    // insert (P): uploadImage + the container (the host, so the hidden file input survives CM's DOM
    // reconcile) — HOST actions, so a nested island gets the bare palette (image/embed/template no-op
    // gracefully; headings·lists·todo·quote·code·divider·link work on the island's own doc).
    ...(readOnly ? [] : [slashPalette(env.nested ? {} : { uploadImage: opts.uploadImage, container: env.container, openPageEmbedPicker: opts.openPageEmbedPicker, openTemplateInsertPicker: opts.openTemplateInsertPicker })]),
  ];
}

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
  opts: LivePreviewSharedOpts & { vim?: boolean; vimCompartment?: Compartment; displayMode?: DisplayMode; displayModeCompartment?: Compartment; searchPhrasesCompartment?: Compartment; onExitEdit?: () => void; onPublish?: () => void; ephemeralCollab?: EphemeralCollabFactory; macroPresence?: MacroPresence; coEditHost?: CoEditHost } = {},
): EditorView {
  // minimalSetup (no line numbers/gutters — this is a reading-style surface).
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      ...(opts.vimCompartment ? [opts.vimCompartment.of(vimCompartmentContent(!!opts.vim))] : [vimEnabled.of(false)]),
      // ADR-056 / #164: editor display mode (live/source/...) via a Compartment so the caller can
      // switch it in place (no remount → collab/presence untouched), like vim.
      ...(opts.displayModeCompartment ? [opts.displayModeCompartment.of(displayModeContent(opts.displayMode ?? "live"))] : [displayMode.of(opts.displayMode ?? "live")]),
      // #402translated search-panel phrases; the host's Compartment lets a language toggle
      // reconfigure them in place (no remount — collab/presence stay attached, the vim-toggle rule).
      ...(opts.searchPhrasesCompartment ? [opts.searchPhrasesCompartment.of(searchPhrasesContent(opts.searchPhrases))] : [searchPhrasesContent(opts.searchPhrases)]),
      minimalSetup,
      // #488: the drop cursor (which shows WHERE a file drag will land, at the same posAtCoords the drop
      // uses) lives in displayModeContent below, NOT here — Reading is a live display-mode SWITCH via a
      // compartment, not a remount, so a mount-time gate would leave it showing after a switch to
      // Reading. It belongs with the EditorState.readOnly the mode already sets.
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
      // (#306 note: the scrolloff itself must NOT live here — a large scroll margin corrupts CM tooltip
      // placement, thepalette regression. It is the updateListener below; these margins stay small.)
      bandScrollMargins,
      // #306: vim-style `scrolloff` — keep the caret inside the middle ~50% band on cursor MOTION. Done as a
      // selection-change listener (NOT via scrollMargins: a large scroll margin corrupts CM tooltip placement —
      // the slash palette rendered ~10000px off-screen). Only on a pure caret move (no doc change), so typing
      // — including opening the "/" palette — is untouched. When the caret leaves the band, scroll the MINIMUM
      // needed to keep it at the band edge (y:"nearest" + yMargin —re-centering "yanked" the view to
      // the middle on every band exit; real scrolloff pins the caret at the ≈75%/25% line and scrolls one line
      // per keypress). Within the band, do nothing (no jitter). Near the ends it scrolls as far as it can.
      // Mouse clicks are excluded (select.pointer): clicking must never move the view (spec). #345: a
      // TOC/anchor jump (select.jump) is also excluded — its own bandScrollMargins already lands the heading
      // flush under the band, and the scrolloff correction would drag that landing ~55px too low (off-by-one
      // scroll-spy).
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet || u.docChanged) return;
        if (u.transactions.some((tr) => tr.isUserEvent("select.pointer") || tr.isUserEvent("select.jump"))) return;
        const view = u.view;
        const prevHead = u.startState.selection.main.head;
        requestAnimationFrame(() => {
          const head = view.state.selection.main.head;
          const coords = view.coordsAtPos(head);
          if (!coords) return;
          const box = view.scrollDOM.getBoundingClientRect();
          const band = box.height * 0.25;
          const above = coords.top < box.top + band;
          const below = coords.bottom > box.bottom - band;
          if (!above && !below) return;
          // How far the view would have to move to put the caret back on the band edge. Scrolling the
          // element directly (rather than scrollIntoView + yMargin) keeps this number honest: CM adds the
          // scrollMargins facet on top of any yMargin, so the old form had to subtract the crossed side's
          // margin to land on the same line, and the two had to be kept in sync by hand — when they drifted
          // the rest line and the trigger line disagreed and the caret see-sawed.
          const need = below ? coords.bottom - (box.bottom - band) : box.top + band - coords.top;
          // #473: pay that distance gradually. A click parks the caret wherever the user clicked — deliberately
          // without scrolling — so it can sit well past the band edge, and the first arrow key used to
          // settle the whole debt at once: the view lurched ~100px while the caret stayed on the same text,
          // which reads as the caret leaping up the screen. Walking into the edge is unaffected (there the
          // debt IS one line, so the step is the whole of it and the caret stays pinned as before); a
          // deliberate long jump is unaffected too (the caret moved that far itself). Only the parked-caret
          // case is spread out, at a fraction of a line per keypress, which is small enough not to read as a
          // jump and still converges on the band in a few presses.
          const prev = view.coordsAtPos(Math.min(prevHead, view.state.doc.length));
          const moved = prev ? Math.abs(coords.top - prev.top) : 0;
          const step = Math.min(need, moved + CATCH_UP_PX);
          if (step <= 0) return;
          view.scrollDOM.scrollTop += below ? step : -step;
        });
      }),
      // ADR-122 addendum (b) / #278: the shared decoration/keymap layer — ONE factory builds this surface
      // AND the nested slot island's config (via nestedLivePreviewConfig below), so island behaviour
      // (reveal / vim-atom / WYSIWYG marker-hide / nested-macro render) can never drift from the outer surface.
      buildLivePreviewExtensions(opts, { nested: false, container: parent }),
      // DEV-only probe: expose the caret's doc line + selection offsets so e2e can
      // assert motion / selection extent. Stripped from prod builds.
      ...(import.meta.env.DEV ? [EditorView.updateListener.of((u) => {
        const w = window as Window & { __lpHeadLine?: number; __lpHeadLineLog?: number[]; __lpSel?: { from: number; to: number; head: number; anchor: number }; __lpRanges?: { from: number; to: number }[]; __lpBlocks?: { fromLine: number; toLine: number }[]; __lpMathAtoms?: { fromLine: number; toLine: number }[]; __lpAtomic?: { fromLine: number; toLine: number }[]; __lpVimInsert?: boolean };
        if (u.selectionSet) {
          const s = u.state.selection.main;
          w.__lpHeadLine = u.state.doc.lineAt(s.head).number;
          w.__lpSel = { from: s.from, to: s.to, head: s.head, anchor: s.anchor };
          w.__lpRanges = u.state.selection.ranges.map((r) => ({ from: r.from, to: r.to })); // #286: all ranges (blockwise vim = one per line)
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
      // Layer (ii): collab/presence — OUTER surface only (a nested island must never live-bind the
      // canonical Y.Text; see buildLivePreviewExtensions).
      // #92: host ephemeral-collab seam for a collab-capable modal (excalidraw); {theme} stays narrow.
      ...(opts.ephemeralCollab ? [ephemeralCollab.of(opts.ephemeralCollab)] : []),
      // #92 presence: bridge "editing a macro's modal" onto the page awareness (read by the overlay below).
      ...(opts.macroPresence ? [macroPresence.of(opts.macroPresence)] : []),
      yCollab(ytext, provider.awareness),
      remoteCursors, // #8: avatar+name flags (additive overlay; yCollab untouched)
      // #92 comment 982 (②③): macro-presence as an outline + top-right avatar on EVERY occupied macro block
      // (modal-editing OR remote caret on the atom). Read-only overlay AFTER yCollab (it reads its awareness).
      ...(opts.macroPresence ? [macroPresenceOverlay] : []),
      // #502 / ADR-184 slice 1: publish the local user's open text-body INLINE-island anchor onto page
      // awareness so peers get the same occupancy chip the modal path already gives (additive `macroEdit`
      // field only; never the sync/offset path). OUTER surface only, alongside the overlay above.
      ...(opts.macroPresence ? [macroPresencePublisher] : []),
      // #502 / ADR-184 slice 2b (final): the co-edit host seam (page awareness + ephemeral-room factory).
      // OUTER member surface only; a co-occupied island editor binds to a shared ephemeral Y.Text through it.
      ...(opts.coEditHost ? [coEditHost.of(opts.coEditHost)] : []),
      // Layer (iii): host chrome (editable surface only; view guests get none). The slash palette itself
      // lives in the shared layer (its vimVisualField still precedes the toolbar's bubble, which reads it
      // to suppress itself in vim visual — the factory sits earlier in this array).
      ...(!opts.readOnly ? [floatingToolbar(), codeFenceSettingsPanel(), vimExCommands({ exitEdit: opts.onExitEdit, publish: opts.onPublish })] : []), // #456 S4/code-fence settings — panel + keyboard opener (Mod-Alt-Enter) + hover ✎, in CM's tooltip layer. #549: contextMenu moved into the shared factory (islands need it too)
      // ADR-122 addendum (b): the nested-editor seam — the slot island builds its decoration/keymap layer
      // from the SAME factory (same opts closure), with nested:true (collab/presence/host chrome excluded).
      nestedLivePreviewConfig.of((env) => buildLivePreviewExtensions(opts, { nested: true, ...env })),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // Drag-and-drop / paste file attach (editable surface only — needs an uploader).
  if (!opts.readOnly && opts.uploadImage) attachFileDrop(view, opts.uploadImage); // #273: all file types (image + attachment)

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
  opts: { resolveImageUrl?: ImageResolver; resolveAttachment?: AttachmentResolver; renderDiagram?: DiagramRenderer; resolveTransclude?: TranscludeResolver; embedProviders?: readonly string[]; onToggleTask?: (index: number, from: number, checked: boolean) => void; titleLinks?: TitleLinkSource; list?: ListSource; linkStatus?: LinkStatusResolver } = {},
): EditorView {
  const view = new EditorView({
    doc: markdown,
    extensions: [
      minimalSetup,
      cmTheme,
      EditorView.lineWrapping,
      bandScrollMargins, // #313: TOC/anchor jumps on the view surface must clear the band too
      markdownExtension(),
      everforestHighlight, // #158-C2: same code highlighting on the read-only published view
      livePreviewTheme,
      livePreview,
      mathField, // #158-C3: KaTeX math ($…$ / $$…$$), reveal-on-cursor atoms
      linkClicks,
      headingAnchors, // #313: same hover 🔗 anchors on the read-only published view
      // #224: auto internal links on the read-only view surface too (same inert-without-source rule).
      titleLinkDecorations(),
      titleLinkHover(),
      ...(opts.titleLinks ? [titleLinkSource.of(opts.titleLinks)] : []),
      checkboxControl.of(opts.onToggleTask ? { mode: "view", onToggle: opts.onToggleTask } : null),
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      // #273: resolves [name](wks-attachment:id) file links -> chip / download card / inline viewer.
      ...(opts.resolveAttachment ? [attachmentResolver.of(opts.resolveAttachment)] : []),
      ...(opts.renderDiagram ? [diagramRenderer.of(opts.renderDiagram)] : []),
      ...(opts.resolveTransclude ? [transcludeResolver.of(opts.resolveTransclude)] : []),
      ...(opts.list ? [listSource.of(opts.list)] : []), // #370 / ADR-145: host-mediated :::tagged / :::children (member-only)
      deadLinks, // #276 / ADR-117: dead-internal-link strikethrough (inert without the linkStatus seam)
      blockAnchors, // #325 / ADR-137 slice 2: hide trailing ` ^id` block-ref markers (reveal on the caret line)
      ...(opts.linkStatus ? [linkStatusResolver.of(opts.linkStatus)] : []),
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
