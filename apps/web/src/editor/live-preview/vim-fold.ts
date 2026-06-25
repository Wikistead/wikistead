import { Vim } from "@replit/codemirror-vim";
import { foldCode, unfoldCode, toggleFold } from "@codemirror/language";

// @replit/codemirror-vim ships NO za/zo/zc key mappings (only the zz/zt/zb scroll
// commands). Map them onto CodeMirror's fold commands so vim users can fold/unfold
// macro blocks (ADR-022 Part 5 — the foldService in macros/fold.ts makes a macro fence
// the foldable range). Idempotent: the Vim singleton is global; registering once is
// enough (HMR self-accepts + reloads, so no double-registration in dev).
let registered = false;
export function registerVimFold(): void {
  if (registered) return;
  registered = true;
  Vim.defineAction("wksFoldToggle", (cm) => { toggleFold(cm.cm6); });
  Vim.defineAction("wksFoldOpen", (cm) => { unfoldCode(cm.cm6); });
  Vim.defineAction("wksFoldClose", (cm) => { foldCode(cm.cm6); });
  Vim.mapCommand("za", "action", "wksFoldToggle", {}, {});
  Vim.mapCommand("zo", "action", "wksFoldOpen", {}, {});
  Vim.mapCommand("zc", "action", "wksFoldClose", {}, {});
}
