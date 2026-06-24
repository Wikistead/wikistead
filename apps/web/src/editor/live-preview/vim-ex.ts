import { Facet, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";

// Light-3: vim ex commands as ENTRY POINTS to existing actions — :q closes edit mode,
// :w publishes, :wq publishes (which, in this app, returns to the rendered view — publish
// == done). The publish path itself is untouched (flush-on-publish stays the bastion);
// these only invoke the host callbacks. Issued from vim NORMAL-mode `:` (vim owns `:`).
export interface ExActions {
  exitEdit?: () => void; // :q — leave edit mode (back to the rendered view)
  publish?: () => void; // :w / :wq — publish via the existing path (→ view on success)
}

// Per-view callbacks. Vim.defineEx is GLOBAL, so the handlers read the actions from the
// facet of the EditorView the command was issued in — acting on the right page.
export const exActions = Facet.define<ExActions, ExActions>({
  combine: (vals) => vals[vals.length - 1] ?? {},
});

// The codemirror-vim ex handler receives the CM5-compat adapter; `.cm6` is the EditorView.
interface VimAdapter { cm6?: EditorView }
const actionsOf = (cm: VimAdapter): ExActions => cm.cm6?.state.facet(exActions) ?? {};

let registered = false;
function registerOnce(): void {
  if (registered) return;
  registered = true;
  Vim.defineEx("quit", "q", (cm: VimAdapter) => actionsOf(cm).exitEdit?.());
  Vim.defineEx("write", "w", (cm: VimAdapter) => actionsOf(cm).publish?.());
  // :wq — publish; the existing publish flow transitions to view on success (== :w here,
  // since publish implies done in this app). Defined explicitly so `:wq` is recognised.
  Vim.defineEx("wq", "wq", (cm: VimAdapter) => actionsOf(cm).publish?.());
}

// Registers the ex commands once (idempotent) and wires this view's callbacks via facet.
export function vimExCommands(actions: ExActions): Extension {
  registerOnce();
  return exActions.of(actions);
}
