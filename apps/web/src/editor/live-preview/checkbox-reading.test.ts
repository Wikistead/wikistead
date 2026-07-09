// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { markdownExtension } from "../markdown-config";
import { livePreview, checkboxControl, displayMode } from "./decorations";

// #314: the task-checkbox DISABLED decision. Reading display mode must NOT disable the box —
// Reading's invariant is "no PROSE editing"; the task toggle is an allowed read-surface operation
// (ADR-019), consistent with the published view surface and WYSIWYG. Disabled is ONLY the
// no-control case (no edit permission / no view-surface handler), the #300 rule minus Reading.

const DOC = "- [ ] task\n\nprose";

// Build the live-preview decorations for DOC (caret parked in the trailing prose so the marker is
// not revealed) and return the CheckboxWidget instance the TaskMarker rendered to.
function checkboxWidget(exts: Extension[]): { checked: boolean; disabled: boolean } | null {
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(DOC.length),
    extensions: [markdownExtension(), livePreview, ...exts],
  });
  const { decorations, atomic } = state.field(livePreview);
  let found: { checked: boolean; disabled: boolean } | null = null;
  for (const set of [decorations, atomic] as DecorationSet[]) {
    set.between(0, DOC.length, (_from, _to, deco) => {
      const w = (deco.spec as { widget?: unknown }).widget as { checked?: unknown; disabled?: unknown } | undefined;
      if (w && typeof w.checked === "boolean" && typeof w.disabled === "boolean") {
        found = w as { checked: boolean; disabled: boolean };
      }
    });
  }
  return found;
}

describe("#314: task checkbox stays enabled in Reading display mode", () => {
  it("Reading + edit control → ENABLED (the #314 fix: reading no longer force-disables)", () => {
    const w = checkboxWidget([checkboxControl.of({ mode: "edit" }), displayMode.of("reading")]);
    expect(w).toBeTruthy();
    expect(w!.disabled).toBe(false);
  });

  it("Reading + NO control (no edit permission) → still DISABLED (the #300 rule is kept)", () => {
    const w = checkboxWidget([displayMode.of("reading")]);
    expect(w).toBeTruthy();
    expect(w!.disabled).toBe(true);
  });

  it("Live + edit control → ENABLED (unchanged)", () => {
    const w = checkboxWidget([checkboxControl.of({ mode: "edit" }), displayMode.of("live")]);
    expect(w).toBeTruthy();
    expect(w!.disabled).toBe(false);
  });

  it("view-surface control (published page) → ENABLED regardless of mode (the #300 invariant)", () => {
    const w = checkboxWidget([checkboxControl.of({ mode: "view", onToggle: () => {} }), displayMode.of("reading")]);
    expect(w).toBeTruthy();
    expect(w!.disabled).toBe(false);
  });
});
