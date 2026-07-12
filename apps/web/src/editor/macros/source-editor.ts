import { EditorView, minimalSetup } from "codemirror"; // meta-package: history + default/history keymaps + drawSelection (same as the host surface)
import { EditorState, type Extension } from "@codemirror/state";
import { vim, getCM } from "@replit/codemirror-vim"; // the SAME vim the outer editor uses (not a second engine)

// #243 / ADR-111 C3 (slice 1): the editUI source pane for a text-source fence macro (mermaid / plantuml)
// upgrades from a bare <textarea> to a small CodeMirror 6 editor — the "rich panel" the ticket asks for
// (undo/redo, a real caret, wrapping, a code face). It is a MACRO-side helper: it uses the @codemirror
// LIBRARY only (the same libraries fence.ts / fold.ts already import), never the host editor's internals,
// so the ADR-023 sandbox boundary ({theme} + save host-API) is unchanged.
//
// Single Y.Text safety (ADR-111 C3 condition 1): this mini-editor holds its OWN document; it commits to the
// host's canonical Y.Text ONLY through the macro's `save` callback (an offset-invariant replaceSource — see
// editUISaveChange). There is NO live binding of this EditorView to a Y.Text sub-range (that would be a second
// CRDT / echo loop, which the single-Y.Text invariant forbids). Commit granularity is on BLUR, not per
// keystroke — a per-keystroke commit re-runs the host doc and would re-mount this widget mid-typing.
//
// vim is intentionally NOT wired here: ADR-111 C3 condition 4 requires the panel to REUSE the outer editor's
// vim (not stand up a SECOND vim engine) and must not widen the {theme} host-API — that needs a host-side CM6
// editUI seam, tracked as C3 slice 2. Escape is left to bubble to the EditableEditUIWidget's capture handler
// (decorations.ts) which owns the #239 exit, so this editor adds no Escape handling.

export interface SourceEditorHandle {
  readonly view: EditorView;
  getValue(): string;
  focus(): void;
  // #243 C3 slice 2b: true when vim is on AND in INSERT mode — the host's editUI Escape handler defers to
  // us so the first Escape does vim insert→normal (stays in the panel), and only a NORMAL-mode Escape exits.
  inVimInsert(): boolean;
  destroy(): void;
}

export interface SourceEditorOptions {
  parent: HTMLElement;
  doc: string;
  dark: boolean;
  testid: string;
  vim?: boolean; // #243 C3 slice 2: mirror the outer editor's vim ON/OFF (same @replit engine, own view-state)
  // #278 §2b: opaque HOST-supplied extensions (e.g. the slash palette) mounted on THIS island's own EditorState.
  // Passed in so this macro-side helper stays sandbox-clean (@codemirror only — it never imports host editor
  // internals like the palette itself); the caller (decorations.ts, host side) owns that wiring.
  extraExtensions?: Extension[];
  // #278 rev4: caller-swappable look. The DEFAULT is the code face below — correct for macros whose
  // source IS code (mermaid / plantuml). A caller editing MARKDOWN CONTENT (the layout slot island) passes its
  // own theme so the editing surface keeps the rendered surface's typography ("editing looks like the render",
  // north star 1) instead of snapping to a small monospace box.
  theme?: Extension;
  onInput: (value: string) => void; // fires on every doc change — drives the local live preview (no doc write)
  onCommit: (value: string) => void; // fires on blur — the single Y.Text write via the macro's save()
}

// A minimal editor theme — code face, no gutter, transparent background so it sits inside the panel chrome.
// #278NO fixed min-height — a short mermaid/plantuml source opened a mostly-empty box (the same
// "editing must not look bigger than the content" bounce as the layout slots). The pane hugs its content;
// an empty doc is still one line tall, so it stays clickable. The code face stays — these macros' source
// IS code (the carve-outmakes explicit).
const baseTheme = EditorView.theme({
  // #278D: font size INHERITS the host editor (the main editor's code face size) rather than a fixed
  // 13px — the user ruled the source panes should feel like the main editor, not a smaller widget. The code
  // FACE stays (var(--font-code)) — mermaid/plantuml source IS code.
  "&": { fontSize: "inherit", background: "transparent" },
  ".cm-content": { fontFamily: "var(--font-code)", padding: "6px 8px" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "1.5" },
  "&.cm-focused": { outline: "none" },
});

export function mountSourceEditor(opts: SourceEditorOptions): SourceEditorHandle {
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        // #243 C3 slice 2: vim FIRST so its keymap takes precedence (mirrors the outer editor's ordering).
        // Same @replit/codemirror-vim the host uses — a per-view vim state, NOT a second/different engine.
        ...(opts.vim ? [vim()] : []),
        ...(opts.extraExtensions ?? []), // #278 §2b: host-supplied (slash palette) — before minimalSetup so its keymap wins
        minimalSetup, // history + default/history keymaps + drawSelection (the host surface uses this too)
        EditorView.lineWrapping,
        opts.theme ?? baseTheme, // #278 rev4: content-editing callers restyle; source-code macros keep the code face

        EditorView.editorAttributes.of({ class: opts.dark ? "cm-dark" : "" }),
        EditorView.updateListener.of((u) => { if (u.docChanged) opts.onInput(u.state.doc.toString()); }),
        // Commit-on-blur → the single offset-invariant Y.Text write (never per-keystroke; see header).
        EditorView.domEventHandlers({ blur: (_e, v) => { opts.onCommit(v.state.doc.toString()); return false; } }),
      ],
    }),
  });
  // The testid lands on the editable surface so specs can click / type / read it like the old textarea.
  view.contentDOM.setAttribute("data-testid", opts.testid);
  view.contentDOM.setAttribute("spellcheck", "false");
  return {
    view,
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    inVimInsert: () => { try { return !!getCM(view)?.state?.vim?.insertMode; } catch { return false; } },
    destroy: () => view.destroy(),
  };
}
