import { EditorView, ViewPlugin, showTooltip, keymap, type Tooltip, type TooltipView } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection, Facet, Prec, type EditorState, type Extension } from "@codemirror/state";
import { Vim, getCM } from "@replit/codemirror-vim";
import i18n from "../../i18n";
import { INLINE_FORMATS, insertImage, insertLink, type InlineFormat, type ImageUploader } from "./commands";
import { orderByRecency, recordUse } from "./palette-recency";
import { contextHintTooltip } from "./hint";
import { registeredMacros } from "../macros";
import { paletteIcon } from "./palette-icons";

// Slash command palette (Step I / M0-1 — see ADR-017). Triggered by `/` at a line
// start OR after whitespace while editing. Lists block insert/toggle commands (layer
// B/C); choosing one removes the typed "/query" token and inserts a plain-Markdown
// TEMPLATE into the canonical Y.Text, placing the caret at the template's content
// position. Offset-invariant and presence-safe (ADR-008), never a special node. Built
// on CodeMirror's tooltip layer (NOT React, NOT cmdk): the editor owns no React
// (ADR-013), and CM reconciles away nodes injected into view.dom (see the floating
// toolbar), so the palette lives in the managed tooltip layer.

interface PaletteCommand {
  id: string;
  label: () => string; // JP display name
  alias: string; // short English name shown small AND used for filtering (no IME switch)
  keywords: string; // extra English filter terms (lowercase)
  insert: string; // the Markdown template inserted in place of the "/query" token
  caret: number | [number, number]; // caret offset (or selection range) within `insert`
  action?: (view: EditorView) => void; // custom action instead of a template insert (e.g. image picker)
  icon?: string; // #357: optional inline-SVG override; when absent, paletteIcon(id) supplies a per-kind icon
}

// Holds the image-insert trigger (opening the host's file picker), supplied by
// slashPalette when an uploader is available. The `/image` command reads it, and its
// presence GATES the command's visibility — guests / uploader-less surfaces never see
// it. Image is layer P (insert, selection-independent), so it lives ONLY here, never in
// the on-selection menus (ADR-018: selection menu = decoration A only).
const imageUploader = Facet.define<(() => void) | null, (() => void) | null>({
  combine: (vals) => vals.find((v) => v != null) ?? null,
});

// #251 / ADR-110: the host seam for the "/"-palette "Insert template" command. The host opens its
// template picker (the same list/preview asset as the sidebar #250 picker) and calls back with the chosen
// template's body markdown (or null on cancel). Its presence GATES the command's visibility (guests /
// picker-less surfaces never see it). The insert is a single offset-invariant Y.Text edit at the caret
// never a replace of the page, and the title is untouched.
export type TemplateInsertPicker = (onInsert: (body: string | null) => void) => void;
const templateInsertPicker = Facet.define<TemplateInsertPicker | null, TemplateInsertPicker | null>({
  combine: (vals) => vals.find((v) => v != null) ?? null,
});

// #205 part 2 / #210: the host page-picker seam is homed in decorations.ts (with the other host
// seams) so the post-insert "change target" affordance reuses it too. When absent (guests /
// picker-less surfaces) the embed-page command falls back to inserting the raw `:::embed-page`
// template so the id can still be typed by hand.
import { pageEmbedPicker, embedUrlPrompt, type PageEmbedPicker, type EmbedUrlPrompt } from "./decorations";
import { escLinkText } from "./paste-linkify"; // #323: the page-link insert escapes the title the same way
export type { PageEmbedPicker };

// Layer B/C/P commands. Template commands place the caret where you'd type the content
// next; the image command (P) runs an action (open the file picker) instead. (Inline
// decorations — layer A — are the decorate palette below.)
const COMMANDS: PaletteCommand[] = [
  { id: "h1", label: () => i18n.t("palette.h1"), alias: "h1", keywords: "heading title #", insert: "# ", caret: 2 },
  { id: "h2", label: () => i18n.t("palette.h2"), alias: "h2", keywords: "heading subtitle ##", insert: "## ", caret: 3 },
  { id: "h3", label: () => i18n.t("palette.h3"), alias: "h3", keywords: "heading ###", insert: "### ", caret: 4 },
  { id: "ul", label: () => i18n.t("palette.bulletList"), alias: "list", keywords: "bullet unordered dash", insert: "- ", caret: 2 },
  { id: "ol", label: () => i18n.t("palette.numberedList"), alias: "1. list", keywords: "numbered ordered", insert: "1. ", caret: 3 },
  // #290 / ADR-114: /todo inserts a PLAIN GFM task list (standard Markdown, no directive). The
  // rich :::todo form (title + progress ring) is reached by PROMOTING the block (table precedent) OR, per the
  // review request, DIRECTLY via its own palette entry below (the promotion path stays unchanged).
  { id: "todo", label: () => i18n.t("palette.todoList"), alias: "todo", keywords: "task checklist checkbox todo done タスク チェック 進捗 やること", insert: "- [ ] ", caret: 6 },
  // #290 (review): the rich :::todo directly — a titled block with a progress ring. Caret lands inside
  // the `[]` title (offset 8 = after ":::todo["). Distinct from /todo so both the plain and rich forms are
  // reachable from the palette; the plain→rich promotion (Ctrl+Enter) is unaffected.
  { id: "todo-ring", label: () => i18n.t("palette.todoRing"), alias: "todo ring", keywords: "todo ring progress タスク 進捗 リング 見出し付き", insert: ":::todo[]\n- [ ] \n:::", caret: 8 },
  { id: "quote", label: () => i18n.t("palette.quote"), alias: "quote", keywords: "blockquote citation", insert: "> ", caret: 2 },
  { id: "code", label: () => i18n.t("palette.codeBlock"), alias: "code", keywords: "code block fenced pre", insert: "```\n\n```", caret: 4 },
  { id: "table", label: () => i18n.t("palette.table"), alias: "table", keywords: "grid", insert: "| Column | Column |\n| --- | --- |\n| Cell | Cell |", caret: [2, 8] },
  // `***` (not `---`): `---` under a line of text is a setext H2 underline, so it would
  // turn the line above into a heading. `***` is always a thematic break (hr).
  { id: "divider", label: () => i18n.t("palette.divider"), alias: "divider", keywords: "rule hr separator line", insert: "***\n", caret: 4 },
  // Link (M0-5): the no-selection door for the dual-behaviour link command. insertLink on
  // an empty selection inserts "[](url)" with "url" selected (URL insert); with a selection
  // it link-ifies it — reached via the bubble / `\` / `/`-on-selection / right-click.
  { id: "link", label: () => i18n.t("palette.link"), alias: "link", keywords: "url href anchor hyperlink", insert: "", caret: 0, action: (view) => insertLink(view) },
  // #356: discoverable named presets for `:::query` so the spec syntax need not be hand-written. "Child pages"
  // is a complete atom (no picker, no id) — the caret lands AFTER the block so it renders immediately (a
  // caret inside would reveal the raw source). "Backlinks" is already reachable via the :::backlinks macro and
  // "Tag members" is a separate picker-gated command below (it needs a page id — never hand-typed, #356).
  { id: "query-children", label: () => i18n.t("palette.queryChildren"), alias: "child pages", keywords: "query children child pages tree list dynamic 子ページ 一覧 動的 クエリ", insert: ":::query\nchildren\n:::", caret: 9 },
];

// #356: "Tag members" — a `:::query\ntag <id>\n:::` list of another tag page's members. Picker-gated (like
// embed-page / page-link): the tag page is CHOSEN from the host page picker (view-gated title search), never
// written as a raw id. Absent on picker-less surfaces. The generated source is the existing ADR-134 spec (no
// notation change — the `:::backlinks` alias / normalization question stays out of this discoverability slice).
const QUERY_TAG_COMMAND: PaletteCommand = {
  id: "query-tag",
  label: () => i18n.t("palette.queryTag"),
  alias: "tag members",
  keywords: "query tag members list dynamic タグ メンバー 一覧 動的 クエリ",
  insert: "",
  caret: 0,
};

// Image insert (layer P). Moved here from the selection bubble (was M0-5, pulled forward)
// so the on-selection menu is decoration-only and identical across vim/non-vim. The token
// is removed, then the action opens the host's file picker; the upload → ![alt](ref) lands
// at the caret (see imageInsert).
const IMAGE_COMMAND: PaletteCommand = {
  id: "image",
  label: () => i18n.t("palette.image"),
  alias: "image",
  keywords: "img picture photo attachment upload",
  insert: "",
  caret: 0,
  action: (view) => view.state.facet(imageUploader)?.(),
};

// Macro slash commands, derived from the registry so ONE registration makes a macro
// insertable (ADR-017/018). Built lazily (at call time, not module-init) so it never
// races macro registration order. A macro with a `slash` field becomes a `/` entry.
function macroCommands(): PaletteCommand[] {
  return registeredMacros()
    .filter((m) => m.slash)
    .map((m) => ({
      id: "macro:" + (m.kind === "fence" ? m.lang : m.name),
      label: () => i18n.t(m.slash!.labelKey),
      alias: m.kind === "fence" ? m.lang : m.name,
      keywords: m.slash!.keywords,
      insert: m.slash!.insert,
      caret: m.slash!.caret ?? m.slash!.insert.length,
    }));
}

// #357 every id the palette can EVER show — the built-ins, the four picker/uploader-gated commands, and
// the registry-derived macro commands (ignoring state gating; the coverage test wants the full universe). The
// `palette-icons.test` asserts each of these has an explicit icon, so nothing ships as a generic square.
export function allPaletteCommandIdsForCoverage(): string[] {
  return [
    ...COMMANDS.map((c) => c.id),
    QUERY_TAG_COMMAND.id, IMAGE_COMMAND.id, PAGE_LINK_COMMAND.id, INSERT_TEMPLATE_COMMAND.id,
    ...macroCommands().map((c) => c.id),
  ];
}

// The effective command list for a state: the image command is appended only when an
// uploader is wired (the facet is set), so it never appears for uploader-less surfaces.
function commandList(state: EditorState): PaletteCommand[] {
  const picker = state.facet(pageEmbedPicker);
  const urlPrompt = state.facet(embedUrlPrompt);
  const macros = macroCommands().map((c) => {
    // #205 part 2: when the host wired a page picker, the embed-page command opens it (title search →
    // insert the chosen id) instead of dropping a raw template. Without the seam it stays a template.
    if (picker && c.id === "macro:embed-page") return { ...c, action: (view: EditorView) => openEmbedPagePicker(view, picker) };
    // #210 bounce: embed-external insert opens the SAME in-app URL modal (embedUrlPrompt) as the ⇆
    // retarget, so the URL + allowlist warning are entered up front instead of dropping a raw template.
    if (urlPrompt && c.id === "macro:embed-external") return { ...c, action: (view: EditorView) => openEmbedExternalPrompt(view, urlPrompt) };
    return c;
  });
  const base = [...COMMANDS, ...macros];
  // #323: "Page link" rides the SAME picker seam as embed-page (no parallel picker) and inserts a
  // standard `[title]/p/id)` link. Present only when the host wired the picker (never for guests /
  // picker-less surfaces). Sits next to the generic /link (URL template) as its internal sibling.
  const withPageLink = picker ? [...base, { ...PAGE_LINK_COMMAND, action: (view: EditorView) => openPageLinkPicker(view, picker) }] : base;
  // #356: "Tag members" query rides the SAME picker seam (view-gated title search → no hand-typed id). Present
  // only when the host wired the picker (member surface) — a guest / picker-less surface never sees it.
  const withQueryTag = picker ? [...withPageLink, { ...QUERY_TAG_COMMAND, action: (view: EditorView) => openQueryTagPicker(view, picker) }] : withPageLink;
  const withImage = state.facet(imageUploader) ? [...withQueryTag, IMAGE_COMMAND] : withQueryTag;
  // #251: append "Insert template" only when the host wired the picker seam (uploader-less/guest surfaces
  // never see it). Its action opens the picker and inserts the chosen body at the caret.
  const tplPicker = state.facet(templateInsertPicker);
  return tplPicker
    ? [...withImage, { ...INSERT_TEMPLATE_COMMAND, action: (view: EditorView) => openTemplateInsert(view, tplPicker) }]
    : withImage;
}

// #323: "Page link" command (layer P — opens the host page picker; the token is removed by applyAt).
// Gated by the pageEmbedPicker facet in commandList.
const PAGE_LINK_COMMAND: PaletteCommand = {
  id: "page-link",
  label: () => i18n.t("palette.pageLink"),
  alias: "page link",
  keywords: "page link internal wiki ページ リンク 内部 ないぶ",
  insert: "",
  caret: 0,
};

// #251: "Insert template" command (layer P — insert, selection-independent). The token is removed by
// applyAt (like image/embed), then the action opens the host picker; the chosen body is inserted at the
// caret. Gated by the templateInsertPicker facet.
const INSERT_TEMPLATE_COMMAND: PaletteCommand = {
  id: "insert-template",
  label: () => i18n.t("palette.insertTemplate"),
  alias: "template",
  keywords: "template insert reuse snippet boilerplate",
  insert: "",
  caret: 0,
};

// Open the host template picker and, on selection, insert the template BODY at the caret (where applyAt
// already removed the "/query" token). Cancel (null) leaves the doc untouched. One offset-invariant Y.Text
// edit — no view/Yjs access from here; the picker + body fetch are host-owned.
function openTemplateInsert(view: EditorView, open: TemplateInsertPicker): void {
  open((body) => {
    if (body == null) { view.focus(); return; }
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: body }, selection: EditorSelection.cursor(at + body.length), scrollIntoView: true });
    view.focus();
  });
}

// Open the host page picker and, on selection, insert `:::embed-page\n<id>\n:::` at the caret (where
// applyAt already removed the "/query" token). Cancel (null) leaves the doc untouched. Offset edit
// only — no view/Yjs access from here (the picker is host-owned; this just writes the chosen id).
// #332: the block is COMPLETE at insert time (the picker supplied the id — nothing left to type). The
// caret lands on the block START, where embed-page's `atomSelectable` (transclude.ts) SELECTS the atom
// the card renders with a selection ring instead of revealing raw. A trailing newline is added only when
// non-newline content follows (so the closing `:::` keeps its own line), never a gratuitous blank line.
// The `/embed` palette runs in vim INSERT mode, so after inserting a completed atom we drop back to
// NORMAL and re-pin the caret on the atom (vim's Esc nudges it left) — otherwise the caret is stranded
// in insert mode below the card. (Fence templates like /mermaid keep insert-inside: their body is empty
// and you type into it.)
function openEmbedPagePicker(view: EditorView, open: PageEmbedPicker): void {
  open((pageId) => {
    if (!pageId) { view.focus(); return; }
    const at = view.state.selection.main.head;
    const needsNl = at < view.state.doc.length && view.state.doc.sliceString(at, at + 1) !== "\n";
    const insert = `:::embed-page\n${pageId}\n:::${needsNl ? "\n" : ""}`;
    view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at), scrollIntoView: true });
    const cm = getCM(view);
    if (cm?.state.vim?.insertMode) { try { Vim.handleKey(cm, "<Esc>", "mapping"); } catch { /* vim unavailable */ } }
    view.dispatch({ selection: EditorSelection.cursor(at) }); // pin the caret on the atom start (a vim Esc moves it left)
    // The host picker's close restores focus to its trigger (now gone → <body>), which lands AFTER a
    // synchronous view.focus. Defer so the editor wins the focus back — otherwise the next keystroke
    // (e.g. Ctrl+Enter to edit the id) is lost to <body>. Same seam the template/link pickers use.
    requestAnimationFrame(() => view.focus());
  });
}

// #323: open the SAME host page picker (no parallel picker) and insert a STANDARD Markdown link
// `[title]/p/<id>)` — never a wiki-link syntax (Open formats: `[[...]]` is an input trigger only and
// is never saved). `replace` is the typed `[[` trigger range to consume; it is re-verified against the
// live doc at pick time (collab may have moved things) and falls back to a plain caret insert. Cancel
// leaves the doc untouched — a typed `[[` stays as ordinary text (no characters lost). The title is
// escaped with the SAME escLinkText the paste-linkifier uses, so `]`/`\` in a title round-trips; the
// raw-id fallback has no title and uses the id as the text.
function openPageLinkPicker(view: EditorView, open: PageEmbedPicker, replace?: { from: number; to: number }): void {
  open((pageId, title) => {
    if (!pageId) { view.focus(); return; }
    const text = (title ?? "").trim() || pageId;
    const insert = `[${escLinkText(text)}](/p/${pageId})`;
    const head = view.state.selection.main.head;
    const r = replace && replace.to <= view.state.doc.length && view.state.sliceDoc(replace.from, replace.to) === "[["
      ? replace
      : { from: head, to: head };
    view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.cursor(r.from + insert.length), scrollIntoView: true });
    view.focus();
  });
}

// #323: typing `[[` opens the page picker (the input trigger). Detection is on the just-typed text
// (input.type user events only — a paste of `[[...]]` stays plain text), edit surfaces only, and only
// when the host wired the picker seam. A third `[` (`[[[`) does not re-fire. On cancel the typed `[[`
// stays put; on pick the trigger text is replaced by the standard link (openPageLinkPicker above).
export function pageLinkTrigger(): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged || u.state.readOnly) return;
    if (!u.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
    const picker = u.state.facet(pageEmbedPicker);
    if (!picker) return;
    const sel = u.state.selection.main;
    if (!sel.empty || sel.head < 2) return;
    if (u.state.sliceDoc(sel.head - 2, sel.head) !== "[[") return;
    if (sel.head >= 3 && u.state.sliceDoc(sel.head - 3, sel.head - 2) === "[") return; // `[[[` — already fired
    openPageLinkPicker(u.view, picker, { from: sel.head - 2, to: sel.head });
  });
}

// #356: open the host page picker and, on selection, insert `:::query\ntag <id>\n:::` at the caret (where
// applyAt already removed the "/query" token) — a dynamic list of the chosen tag page's members. The tag page
// is picked by view-gated title search, never a hand-typed id (#356's discoverability goal). Same picker seam
// as embed-page / page-link; cancel leaves the doc untouched. One offset-invariant Y.Text edit. The caret lands
// on the block start (the macro reveals raw there; moving off renders the list) — a completed atom, nothing to type.
function openQueryTagPicker(view: EditorView, open: PageEmbedPicker): void {
  open((pageId) => {
    if (!pageId) { view.focus(); return; }
    const at = view.state.selection.main.head;
    const needsNl = at < view.state.doc.length && view.state.doc.sliceString(at, at + 1) !== "\n";
    const insert = `:::query\ntag ${pageId}\n:::${needsNl ? "\n" : ""}`;
    view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at), scrollIntoView: true });
    const cm = getCM(view);
    if (cm?.state.vim?.insertMode) { try { Vim.handleKey(cm, "<Esc>", "mapping"); } catch { /* vim unavailable */ } }
    view.dispatch({ selection: EditorSelection.cursor(at) }); // pin caret on the atom start (a vim Esc moves it left)
    requestAnimationFrame(() => view.focus());
  });
}

// #210 bounce: open the host URL modal (seeded empty) and, on submit, insert `:::embed-external\n<url>\n:::`.
// Cancel/empty leaves the doc untouched. Same seam the ⇆ retarget uses, so insert + retarget share the modal.
function openEmbedExternalPrompt(view: EditorView, prompt: EmbedUrlPrompt): void {
  prompt("", (url) => {
    if (url == null || url.trim() === "") { view.focus(); return; }
    const at = view.state.selection.main.head;
    const insert = `:::embed-external\n${url.trim()}\n:::`;
    view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), scrollIntoView: true });
    view.focus();
  });
}

function filterCommands(state: EditorState, query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  const list = commandList(state);
  const matched = !q
    ? list
    : list.filter(
        (c) => c.label().toLowerCase().includes(q) || c.alias.toLowerCase().includes(q) || c.keywords.includes(q),
      );
  // Float recently-used commands to the top (Light-2); stable for everything else.
  return orderByRecency("insert", matched, (c) => c.id);
}

// Scroll the capped palette so the selected row is visible. Manual scrollTop (not
// scrollIntoView): the palette is a position:fixed CM tooltip, where scrollIntoView's
// scrollable-ancestor walk doesn't reliably pick it. offsetTop is relative to the
// (positioned) tooltip, so this is deterministic. Deferred to the next frame because CM
// applies the tooltip's capped height AFTER our render runs — measuring clientHeight then.
function keepInView(container: HTMLElement, row: HTMLElement | null): void {
  if (!row) return;
  requestAnimationFrame(() => {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
  });
}

interface PaletteState { from: number; query: string; index: number }

const moveSelection = StateEffect.define<number>(); // +1 / -1
const dismissPalette = StateEffect.define<null>();

// Esc dismissal: held in a tiny companion field so the palette can be hidden without
// removing the typed text. Any further typing (docChanged) re-arms it.
const dismissedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(dismissPalette))) return true;
    if (tr.docChanged) return false;
    return value;
  },
});

// Is the cursor right after a "/query" token whose `/` is at line start OR preceded by
// whitespace (so prose like "and/or" never fires, but "# heading /" and line-start do)?
function detect(state: EditorView["state"]): { from: number; query: string } | null {
  if (state.readOnly) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null; // decoration-on-selection is M0-2
  const line = state.doc.lineAt(sel.head);
  const before = state.doc.sliceString(line.from, sel.head);
  const m = /(?:^|\s)\/([\p{L}\p{N}-]*)$/u.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { from: sel.head - query.length - 1, query }; // position of the "/"
}

const paletteField = StateField.define<PaletteState | null>({
  create: () => null,
  update(value, tr) {
    if (tr.state.field(dismissedField)) return null;
    const d = detect(tr.state);
    if (!d) return null;
    const matches = filterCommands(tr.state, d.query);
    if (matches.length === 0) return null; // no command → behave as plain text
    let index = value && value.query === d.query ? value.index : 0;
    for (const e of tr.effects) if (e.is(moveSelection)) index += e.value;
    index = ((index % matches.length) + matches.length) % matches.length; // wrap
    return { from: d.from, query: d.query, index };
  },
  provide: (f) =>
    showTooltip.computeN([f, dismissedField], (state) => {
      const v = state.field(f);
      return v ? [paletteTooltip(f, v.from)] : [];
    }),
});

function applyAt(view: EditorView, cmd: PaletteCommand): void {
  const v = view.state.field(paletteField);
  if (!v) return;
  recordUse("insert", cmd.id); // Light-2: learn recently-used commands
  const head = view.state.selection.main.head;
  if (cmd.action) {
    // Action command (e.g. image): remove the "/query" token, place the caret where it
    // was, then run the action — its async result (the upload) inserts at that caret.
    view.dispatch({ changes: { from: v.from, to: head, insert: "" }, selection: EditorSelection.cursor(v.from) });
    view.focus();
    cmd.action(view);
    return;
  }
  const at = v.from; // template is inserted starting here (replacing "/query")
  const selection = Array.isArray(cmd.caret)
    ? EditorSelection.range(at + cmd.caret[0], at + cmd.caret[1])
    : EditorSelection.cursor(at + cmd.caret);
  // #271 / #243 (ADR-111 C1): the caret lands inside the inserted fence body. For a mermaid/plantuml fence
  // the #243 caret-in reveal now shows the raw source automatically (no explicit render-active needed) — so
  // the caret sits on a real visible line, typing shows, and moving the caret out renders the diagram. We no
  // longer set an explicit raw render-active here: under C4 that would open the editUI, not the raw source.
  view.dispatch({ changes: { from: v.from, to: head, insert: cmd.insert }, selection, scrollIntoView: true });
  view.focus();
}

function paletteTooltip(field: StateField<PaletteState | null>, from: number): Tooltip {
  return {
    pos: from,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view): TooltipView => {
      const dom = document.createElement("div");
      dom.className = "lp-palette";
      dom.setAttribute("data-testid", "slash-palette");
      const render = () => {
        const v = view.state.field(field);
        if (!v) return;
        const matches = filterCommands(view.state, v.query);
        dom.replaceChildren();
        let selectedRow: HTMLElement | null = null;
        matches.forEach((cmd, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lp-palette-row" + (i === v.index ? " is-selected" : "");
          row.setAttribute("data-testid", `slash-item-${cmd.id}`);
          if (i === v.index) { row.setAttribute("data-selected", "true"); selectedRow = row; }
          // #357: a leading type icon (inline SVG, currentColor → theme-follow) so the kind reads at a glance.
          const icon = document.createElement("span");
          icon.className = "lp-palette-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = cmd.icon ?? paletteIcon(cmd.id); // trusted constant SVG (no user input)
          const name = document.createElement("span");
          name.className = "lp-palette-name";
          name.textContent = cmd.label();
          const alias = document.createElement("span");
          alias.className = "lp-palette-alias";
          alias.textContent = cmd.alias;
          row.append(icon, name, alias);
          // mousedown (not click) + preventDefault keeps editor focus/selection intact
          row.addEventListener("mousedown", (e) => { e.preventDefault(); applyAt(view, cmd); });
          dom.appendChild(row);
        });
        // Keep the selected row visible when the capped list scrolls (e.g. nav to image,
        // the last item).
        keepInView(dom, selectedRow as HTMLElement | null);
      };
      render();
      return {
        dom,
        update: (u) => { if (u.docChanged || u.state.field(field) !== u.startState.field(field)) render(); },
      };
    },
  };
}

// Keymap active only while the palette is open (else the keys pass through to vim /
// the editor). Highest precedence so the nav keys are captured before defaults.
//
// vim-style nav uses Ctrl-j/Ctrl-k, NOT Ctrl-n/Ctrl-p: Ctrl+N (and Ctrl+T/Ctrl+W) are
// browser-reserved shortcuts the page cannot intercept (Ctrl+N opened a new window).
// Ctrl+J/Ctrl+K reach the page and ARE cancellable, and j/k match vim's down/up.
// IMPORTANT: NO preventDefault flag — the handlers only consume the key (via returning
// true → CM preventDefaults) WHEN the palette is open. When closed they return false,
// so Ctrl-k stays the global page-search shortcut (SearchBox bails on defaultPrevented).
// Arrow/Tab remain as always-safe fallbacks.
const paletteKeymap = Prec.highest(
  keymap.of([
    // `/` with a SELECTION opens the decorate palette (ADR-018 #4: `/` is insert-primary
    // but also offers decoration on a selection); with no selection it types normally →
    // the insert palette. Gated off in vim normal/visual (there `/` is vim search).
    { key: "/", run: openDecorateOnSlash },
    { key: "ArrowDown", run: (v) => move(v, +1) },
    { key: "ArrowUp", run: (v) => move(v, -1) },
    { key: "Ctrl-j", run: (v) => move(v, +1) },
    { key: "Ctrl-k", run: (v) => move(v, -1) },
    { key: "Tab", run: (v) => move(v, +1) },
    { key: "Shift-Tab", run: (v) => move(v, -1) },
    { key: "Enter", run: chooseSelected },
    { key: "Escape", run: dismiss },
    // (The decorate palette's nav / mnemonic / Enter / Escape are handled by the
    // decorateKeys dom handler, not here — it must beat vim's keymap. See below.)
  ]),
);

function isOpen(view: EditorView): boolean {
  return view.state.field(paletteField, false) != null;
}
function move(view: EditorView, delta: number): boolean {
  if (isOpen(view)) { view.dispatch({ effects: moveSelection.of(delta) }); return true; }
  if (isDecorateOpen(view)) { view.dispatch({ effects: moveDecorate.of(delta) }); return true; }
  return false;
}
function chooseSelected(view: EditorView): boolean {
  const v = view.state.field(paletteField, false);
  if (v) { const cmd = filterCommands(view.state, v.query)[v.index]; if (cmd) applyAt(view, cmd); return true; }
  return chooseDecorate(view);
}
function dismiss(view: EditorView): boolean {
  if (isOpen(view)) { view.dispatch({ effects: dismissPalette.of(null) }); return true; }
  if (isDecorateOpen(view)) { view.dispatch({ effects: closeDecorate.of(null) }); return true; }
  return false;
}

// ── Selection (decorate) palette ───────────────────────────────────────────
// Layer-A formats applied to the selection. Opened by vim visual `\`, selection-`/`
// (non-vim / vim-insert), and (later) the bubble's "⋯". Items come from the SHARED
// INLINE_FORMATS (ADR-018 #3) so they match the toolbar exactly. Navigated by Arrow /
// Ctrl-j/k / Enter / click, OR a one-key mnemonic (ADR-018 #2): the running command
// wraps the still-intact selection (a normal edit → presence-safe).
const DECORATE = INLINE_FORMATS;
// The decorate items, recently-used first (Light-2). Stable within an open session
// (recency only changes on apply, which closes the palette), so the index used by
// render / nav / chooseDecorate stays consistent.
function decorateList(): InlineFormat[] {
  return orderByRecency("decorate", DECORATE, (f) => f.id);
}

const openDecorate = StateEffect.define<{ from: number }>();
const moveDecorate = StateEffect.define<number>();
const closeDecorate = StateEffect.define<null>();

// Is the slash palette or the decorate palette currently open? Used to suppress the
// macro reveal↔render hint while a palette is showing (no overlapping tooltips).
export function isPaletteOpen(state: EditorState): boolean {
  return state.field(paletteField, false) != null || state.field(decorateField, false) != null;
}

const decorateField = StateField.define<{ from: number; index: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openDecorate)) return { from: e.value.from, index: 0 };
      if (e.is(closeDecorate)) return null;
    }
    if (!value) return null;
    // Close once the selection collapses (command applied / caret moved) or doc changes.
    if (tr.docChanged || tr.newSelection.main.empty) return null;
    let index = value.index;
    for (const e of tr.effects) if (e.is(moveDecorate)) index += e.value;
    index = ((index % DECORATE.length) + DECORATE.length) % DECORATE.length;
    return { from: value.from, index };
  },
  provide: (f) =>
    showTooltip.computeN([f], (state) => {
      const v = state.field(f);
      return v ? [decorateTooltip(f, v.from)] : [];
    }),
});

function isDecorateOpen(view: EditorView): boolean {
  return view.state.field(decorateField, false) != null;
}
function applyDecorate(view: EditorView, cmd: InlineFormat): void {
  if (!isDecorateOpen(view)) return;
  recordUse("decorate", cmd.id); // Light-2: learn recently-used formats
  cmd.run(view); // wraps the (still-intact) selection; the doc change closes the field
}

function decorateTooltip(field: StateField<{ from: number; index: number } | null>, from: number): Tooltip {
  return {
    pos: from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view): TooltipView => {
      const dom = document.createElement("div");
      dom.className = "lp-palette";
      dom.setAttribute("data-testid", "decorate-palette");
      const render = () => {
        const v = view.state.field(field);
        if (!v) return;
        dom.replaceChildren();
        let selectedRow: HTMLElement | null = null;
        decorateList().forEach((cmd, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lp-palette-row" + (i === v.index ? " is-selected" : "");
          row.setAttribute("data-testid", `decorate-item-${cmd.id}`);
          if (i === v.index) { row.setAttribute("data-selected", "true"); selectedRow = row; }
          const name = document.createElement("span");
          name.className = "lp-palette-name";
          name.textContent = i18n.t(cmd.labelKey);
          const alias = document.createElement("span");
          alias.className = "lp-palette-alias";
          alias.textContent = cmd.mnemonic;
          row.append(name, alias);
          row.addEventListener("mousedown", (e) => { e.preventDefault(); applyDecorate(view, cmd); });
          dom.appendChild(row);
        });
        // Keep the selected row visible when the list scrolls (parity with the insert palette).
        keepInView(dom, selectedRow as HTMLElement | null);
      };
      render();
      return {
        dom,
        update: (u) => { if (u.state.field(field) !== u.startState.field(field)) render(); },
      };
    },
  };
}

// The decorate (selection) palette is opened by vim visual `\` (M0-3), selection-`/`
// (ADR-018 #4), the bubble's "⋯ more", and right-click (M0-4).
function chooseDecorate(view: EditorView): boolean {
  const v = view.state.field(decorateField, false);
  if (!v) return false;
  const cmd = decorateList()[v.index];
  if (cmd) applyDecorate(view, cmd);
  return true;
}

const isVimVisual = (view: EditorView): boolean => !!getCM(view)?.state.vim?.visualMode;

// `/` with a selection opens the decorate palette (ADR-018 #4). Gated off in vim
// normal/visual mode, where `/` is vim search (vim's selection-decoration door is `\`).
// With no selection this returns false → `/` types normally → the insert palette.
function openDecorateOnSlash(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const cm = getCM(view);
  if (cm && !cm.state.vim?.insertMode) return false; // vim normal/visual → `/` is search
  view.dispatch({ effects: openDecorate.of({ from: sel.from }) });
  return true;
}

// Key handling WHILE the decorate palette is open. A domEventHandlers (NOT a keymap)
// at highest precedence — same reason as backslashDecorate: in vim VISUAL mode the vim
// keymap consumes plain keys (`b` = back-word, `j/k` = motion, Enter, Escape) before any
// CM keymap runs, so the mnemonic fast-path (#2) and nav must intercept at the dom layer
// to beat vim. Only fires when the decorate palette is open (else passes through, so the
// insert palette's keymap and normal typing/vim are untouched).
const decorateKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (!isDecorateOpen(view)) return false;
      if (e.altKey || e.metaKey) return false;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { view.dispatch({ effects: moveDecorate.of(+1) }); e.preventDefault(); return true; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { view.dispatch({ effects: moveDecorate.of(-1) }); e.preventDefault(); return true; }
      if (e.ctrlKey) return false;
      if (e.key === "Enter") { chooseDecorate(view); e.preventDefault(); return true; }
      if (e.key === "Escape") { view.dispatch({ effects: closeDecorate.of(null) }); e.preventDefault(); return true; }
      const fmt = INLINE_FORMATS.find((f) => f.mnemonic === e.key);
      if (fmt) { applyDecorate(view, fmt); e.preventDefault(); return true; }
      return false;
    },
  }),
);

// M0-3: vim VISUAL-mode `\` opens the selection palette. Matched by physical KEY CODE
// (Backslash on US; IntlRo / IntlYen on JIS), NOT by character — codemirror-vim's
// char-based key handling mangles `¥` on JIS, so a keycode intercept is the only robust
// way (ADR-017/018). Highest precedence + preventDefault so vim never sees it; only
// fires in vim visual mode with a selection, so normal/visual `/`-search and everything
// else are untouched.
const backslashDecorate = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (e.code !== "Backslash" && e.code !== "IntlRo" && e.code !== "IntlYen") return false;
      if (!isVimVisual(view)) return false;
      const sel = view.state.selection.main;
      if (sel.empty) return false;
      view.dispatch({ effects: openDecorate.of({ from: sel.from }) });
      e.preventDefault();
      return true;
    },
  }),
);

// Shared "vim visual mode with a selection" flag. vim's mode isn't in EditorState
// (only reachable via getCM(view)), so an updateListener syncs it into a StateField
// that StateField-level consumers (the hint tooltip here, the bubble in toolbar.ts) can
// read. Exported so the floating toolbar can suppress itself in vim visual (the hint
// takes the ribbon spot instead).
const setVimVisual = StateEffect.define<boolean>();
export const vimVisualField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVimVisual)) return e.value;
    return value;
  },
});
const vimVisualSync = EditorView.updateListener.of((u) => {
  const want = isVimVisual(u.view) && !u.view.state.selection.main.empty;
  if (u.view.state.field(vimVisualField) !== want) u.view.dispatch({ effects: setVimVisual.of(want) });
});

// A small, unobtrusive hint shown ONLY during a vim VISUAL selection, at the format
// toolbar's spot (a tooltip above the selection): tells the user `\` opens the format/
// macro palette (matching backslashDecorate). Display-only — a CM tooltip (NOT a node in
// view.dom, #8), no text/decoration, so document offsets / presence are untouched.
// Hidden in normal/insert/non-vim and while the palette is already open (and the full
// toolbar bubble is suppressed in vim visual, so the hint replaces it — no overlap).
const vimHintField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_value, tr) {
    const show = tr.state.field(vimVisualField) && tr.state.field(decorateField, false) == null;
    return show ? [contextHintTooltip(tr.state.selection.main.from, i18n.t("palette.vimHint"), "vim-decorate-hint")] : [];
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

// Wires the host's uploader into the `/image` command: a hidden file input (kept in the
// React-owned host container, which CM never reconciles, so it survives edits) plus the
// trigger exposed via the imageUploader facet. On a chosen file it uploads and inserts
// ![alt](ref) at the CURRENT caret — so it works whether opened via the `/image` command
// or driven directly (e.g. tests setting the input). Same path as the old toolbar button.
function imageInsert(upload: ImageUploader, container?: HTMLElement): Extension {
  let view: EditorView | null = null;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  input.setAttribute("data-testid", "lp-image-input");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file || !view) return;
    const v = view;
    void upload(file).then((res) => { if (res) insertImage(v, res.alt, res.ref); });
  });
  (container ?? document.body).appendChild(input);
  // Capture the view (for insertImage) + clean up the input when the editor is destroyed.
  const lifecycle = ViewPlugin.define((v) => { view = v; return { destroy() { input.remove(); view = null; } }; });
  return [imageUploader.of(() => input.click()), lifecycle];
}

export function slashPalette(opts: { uploadImage?: ImageUploader; container?: HTMLElement; openPageEmbedPicker?: PageEmbedPicker; openTemplateInsertPicker?: TemplateInsertPicker } = {}): Extension {
  // Order matters: vimVisualField before vimHintField (the field reads it); both before
  // the floating toolbar's bubble (added after slashPalette) so the bubble can read it.
  const core = [dismissedField, paletteField, decorateField, vimVisualField, vimHintField, paletteKeymap, decorateKeys, backslashDecorate, vimVisualSync];
  const ext = opts.uploadImage ? [...core, imageInsert(opts.uploadImage, opts.container)] : core;
  // #323: the `[[` input trigger ships with the picker seam (it no-ops without it — the facet is null).
  const withEmbed = opts.openPageEmbedPicker ? [...ext, pageEmbedPicker.of(opts.openPageEmbedPicker), pageLinkTrigger()] : ext;
  return opts.openTemplateInsertPicker ? [...withEmbed, templateInsertPicker.of(opts.openTemplateInsertPicker)] : withEmbed;
}
