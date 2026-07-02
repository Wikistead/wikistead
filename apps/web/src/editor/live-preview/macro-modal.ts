import { EditorView } from "@codemirror/view";
import type { FenceMacro, DirectiveMacro, MacroTheme, MacroSource } from "../macros/registry";
import { asMacroSource } from "../macros/registry";
import { macroFenceAt, directiveMacroAt, tableBlockAt } from "../macros/fence";
import { autoDemote } from "../macros/tier-cap";
import { ephemeralCollab } from "./decorations";
import { tableModalEditor, tableTier } from "../macros/table";

// Rich-edit a macro block in a modal (ADR-022 Part 3 / #86 for the table). The overlay is plain
// DOM — the macro mounts its own editor INSIDE it, NEVER in CodeMirror (ADR-013), so an embedded
// React editor (Excalidraw) or a contenteditable table cell can't fight CM for focus. On save the
// new body is written to the block's CURRENT source range (re-derived from the live position, so a
// remote shift is handled): one range replace on the shared Y.Text = (a) collab, block-level LWW.

// The shared modal shell: overlay + panel + bar (Cancel/Save) + content host. `onSave` is invoked
// before close. Returns the content host, a close(), and onMounted() to register the editor's
// controller for cleanup (handling a mount that resolves after an early close).
function modalFrame(
  view: EditorView,
  titleText: string,
  onSave: () => void,
): { content: HTMLElement; close: () => void; onMounted: (destroy: () => void) => void } {
  const overlay = document.createElement("div");
  overlay.className = "wks-macro-modal";
  overlay.tabIndex = -1; // focusable so Escape reaches the overlay listener (below)
  overlay.setAttribute("data-testid", "macro-modal");
  const panel = document.createElement("div");
  panel.className = "wks-macro-modal-panel";
  const bar = document.createElement("div");
  bar.className = "wks-macro-modal-bar";
  const title = document.createElement("span");
  title.className = "wks-macro-modal-title";
  title.textContent = titleText;
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "wks-macro-modal-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.setAttribute("data-testid", "macro-modal-cancel");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "wks-macro-modal-btn wks-macro-modal-save";
  saveBtn.textContent = "Save";
  saveBtn.setAttribute("data-testid", "macro-modal-save");
  bar.append(title, spacer, cancelBtn, saveBtn);
  const content = document.createElement("div");
  content.className = "wks-macro-modal-content";
  panel.append(bar, content);
  overlay.append(panel);
  document.body.append(overlay);
  overlay.focus(); // so a bare Escape (no cell being typed) closes the modal

  let destroyFn: (() => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    destroyFn?.();
    overlay.remove();
    view.focus();
  };
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", () => { onSave(); close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  return { content, close, onMounted: (d) => { if (closed) d(); else destroyFn = d; } };
}

// Fenced-code (```lang) and container-directive (:::name) macros with a modal editor.
export function openMacroModal(
  view: EditorView,
  macro: FenceMacro | DirectiveMacro,
  getPos: () => number, // live position of the block (view.posAtDOM(wrap))
  theme: MacroTheme,
): void {
  if (macro.richEditUI?.present !== "modal") return;
  const resolve = () => {
    if (macro.kind === "directive") {
      const d = directiveMacroAt(view.state, getPos());
      return d && { from: d.from, to: d.to, body: d.body, wrap: (b: string) => `:::${d.name}\n${b}\n:::` };
    }
    const f = macroFenceAt(view.state, getPos());
    return f && { from: f.from, to: f.to, body: f.body, wrap: (b: string) => "```" + f.lang + "\n" + b + "\n```" };
  };
  const start = resolve();
  if (!start) return;
  const originalBody = start.body;
  let getBody: () => MacroSource = () => asMacroSource(originalBody);
  const frame = modalFrame(view, "summary" in macro ? macro.summary(originalBody) : macro.name, () => {
    const cur = resolve();
    if (!cur) return;
    if (cur.body !== originalBody) console.warn("macro block was edited concurrently; applying last write");
    // Tier auto-demote on save to the lowest representable layer (ADR-025 open formats; #93 — no
    // tenant level-cap). No tier (Excalidraw) → as-is.
    let source = asMacroSource(cur.wrap(getBody()));
    if (macro.tier) source = autoDemote(macro.tier, source);
    view.dispatch({ changes: { from: cur.from, to: cur.to, insert: source } });
  });
  // #92 / ADR-093: for a collab-capable modal (excalidraw), open the host's ephemeral room (keyed by the
  // block's anchor = its from-offset, consistent across concurrent editors of the same block state) and
  // hand the session to mount. The macro's own API stays {theme}; collab is this separate host channel.
  const collabFactory = macro.richEditUI.collab ? view.state.facet(ephemeralCollab) : null;
  const session = collabFactory ? collabFactory(String(start.from)) : undefined;
  void macro.richEditUI.editor.mount(frame.content, asMacroSource(originalBody), { theme }, session).then((c) => {
    getBody = () => c.getBody();
    frame.onMounted(() => { c.destroy(); session?.destroy(); });
  });
}

// The table modal (#86): a table is a pipe table OR a :::table directive, so it uses tableBlockAt
// (handles both) and feeds the editor the FULL block source. On save the tier auto-demotes a
// span/style-free table back to a plain GFM pipe table (open formats).
export function openTableModal(view: EditorView, getPos: () => number, theme: MacroTheme): void {
  const start = tableBlockAt(view.state, getPos());
  if (!start) return;
  const originalSource = asMacroSource(view.state.sliceDoc(start.from, start.to));
  let getBody: () => MacroSource = () => originalSource;
  const frame = modalFrame(view, "Table", () => {
    const cur = tableBlockAt(view.state, getPos());
    if (!cur) return;
    view.dispatch({ changes: { from: cur.from, to: cur.to, insert: autoDemote(tableTier, getBody()) } });
  });
  void tableModalEditor.mount(frame.content, originalSource, { theme }).then((c) => {
    getBody = () => c.getBody();
    frame.onMounted(() => c.destroy());
  });
}
