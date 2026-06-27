import { EditorView } from "@codemirror/view";
import type { FenceMacro, DirectiveMacro, MacroModalController, MacroTheme } from "../macros/registry";
import { macroFenceAt, directiveMacroAt } from "../macros/fence";
import { applyTier } from "./macro-edit";

// Rich-edit a macro block in a modal (ADR-022 Part 3). The overlay is plain DOM — the
// macro mounts its own editor (React for Excalidraw) INSIDE it, never in CodeMirror
// (ADR-013). On save, the new body is written back to the macro's CURRENT source range,
// re-derived from the live widget position (so a remote edit that shifted the block is
// handled): a range replace on the shared Y.Text = (a) collab, block-level last-write-
// wins. If the block's own source changed while the modal was open (concurrent edit),
// last-write-wins still applies but is surfaced (a toast/console) rather than silent.
export function openMacroModal(
  view: EditorView,
  macro: FenceMacro | DirectiveMacro,
  getPos: () => number, // live position of the block (view.posAtDOM(wrap))
  theme: MacroTheme,
): void {
  if (macro.richEditUI?.present !== "modal") return;
  // Resolve the block's CURRENT range + body and how to re-serialize body → source. Works for
  // a fenced-code macro (```lang) and a container directive (:::name) alike (#86: table modal).
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

  const overlay = document.createElement("div");
  overlay.className = "wks-macro-modal";
  overlay.setAttribute("data-testid", "macro-modal");
  const panel = document.createElement("div");
  panel.className = "wks-macro-modal-panel";
  const bar = document.createElement("div");
  bar.className = "wks-macro-modal-bar";
  const title = document.createElement("span");
  title.className = "wks-macro-modal-title";
  title.textContent = "summary" in macro ? macro.summary(originalBody) : macro.name;
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

  let controller: MacroModalController | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    controller?.destroy();
    overlay.remove();
    view.focus();
  };
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", () => {
    const body = controller?.getBody() ?? originalBody;
    // Re-derive the block's CURRENT range from the live position (handles remote shifts).
    const cur = resolve();
    if (cur) {
      if (cur.body !== originalBody) {
        // The block's source changed while editing → last-write-wins (a-scope collab).
        console.warn("macro block was edited concurrently; applying last write");
      }
      // Tier auto-demote on save (open formats): a span/style-free table is written back as a
      // plain GFM pipe table, not :::table. No tier (e.g. Excalidraw) → the wrapped form as-is.
      let source = cur.wrap(body);
      if (macro.tier) source = applyTier(macro.tier, source);
      view.dispatch({ changes: { from: cur.from, to: cur.to, insert: source } });
    }
    close();
  });
  // Esc cancels.
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });

  void macro.richEditUI.editor.mount(content, originalBody, { theme }).then((c) => {
    if (closed) c.destroy();
    else controller = c;
  });
}
