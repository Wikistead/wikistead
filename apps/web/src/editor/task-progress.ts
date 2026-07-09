import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { countTasks } from "./macros/progress";

export interface TaskProgress {
  readonly done: number;
  readonly total: number;
}

// #290 / ADR-114 (increment A): recompute the WHOLE page's GFM-checkbox progress on every doc change (and
// once at init) and hand it to the host — display-only, reads state, NEVER dispatches, exactly like
// headingsExtension (the proven TOC seam, NOT the dirty-signal path the presence constraint warns about). The
// host renders a small ring in the title band. Fires ONLY when the counts change (dedup), so it doesn't churn
// React on every keystroke. Live compute (offset-invariant read), so the single-Y.Text invariant holds.
export function taskProgressExtension(onTaskProgress: (p: TaskProgress) => void): Extension {
  let last = { done: -1, total: -1 };
  let inited = false;
  return EditorView.updateListener.of((u) => {
    if (!inited || u.docChanged) {
      inited = true;
      const p = countTasks(u.state.doc.toString());
      if (p.done !== last.done || p.total !== last.total) {
        last = p;
        onTaskProgress(p);
      }
    }
  });
}
