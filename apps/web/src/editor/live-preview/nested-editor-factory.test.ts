// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import * as Y from "yjs";
import { buildLivePreviewExtensions } from "../editor-livepreview";
import { livePreview, displayMode, vimEnabled, blockEntry } from "./decorations";
import { macroEdit } from "./macro-edit";
import { mathField } from "./math";
import { listEditing } from "./list-edit";
import { deadLinks } from "./dead-links";
import { blockAnchors } from "./block-anchor";
import { blockDrag } from "./block-drag";
import "../macros"; // register macros so livePreview resolves fences/directives like the real surface

// ADR-122 addendum (b) / #278: ONE factory (buildLivePreviewExtensions) builds the decoration/keymap
// layer for BOTH the outer surface and the nested slot island. These are the addendum's anti-tests at
// the unit level (the real-DOM geometry halves live in e2e):
//   1. the island's rendered/hidden result MATCHES the outer editor for the same doc+caret (live reveal,
//      WYSIWYG marker-hide) — proving the shared factory, not a re-derived subset;
//   2. the nested build carries the SAME layer pieces by IDENTITY (no fork can drift silently) while
//      page-structure affordances (block drag) stay outer-only;
//   3. single Y.Text: a nested mount holds its OWN doc — a "remote" Y.Text edit never appears inside it,
//      and its own edit never writes the Y.Text (commit-on-blur is the only write path, outside this layer).

const islandLayer = (dm: "live" | "wysiwyg") => buildLivePreviewExtensions({}, { nested: true, vim: false, displayMode: dm });
// The outer mount supplies vim/displayMode via Compartments — modelled here as bare facets (same values).
const outerExts = (dm: "live" | "wysiwyg") => [minimalSetup, vimEnabled.of(false), displayMode.of(dm), buildLivePreviewExtensions({}, { nested: false })];
const islandExts = (dm: "live" | "wysiwyg") => [minimalSetup, islandLayer(dm)];

const mk = (extensions: Extension, doc: string, caret: number) =>
  EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions });

// A comparable dump of everything livePreview decided (decorations + atomic ranges): position plus the
// spec's class/widget-ness. Equal dumps = the two surfaces rendered/hid exactly the same things.
function dump(s: EditorState): string[] {
  const f = s.field(livePreview);
  const out: string[] = [];
  for (const set of [f.decorations, f.atomic]) {
    const it = set.iter();
    while (it.value) {
      const spec = (it.value as { spec?: { class?: string; widget?: unknown } }).spec ?? {};
      out.push(`${it.from}:${it.to}:${spec.class ?? ""}:${spec.widget ? "w" : ""}`);
      it.next();
    }
  }
  return out;
}

const DOC = "# Title\n\nsome *emphasis* text";
const AWAY = DOC.length; // caret on the last line, away from the heading
const ON = 1; // caret inside the heading marker

describe("nested-editor shared factory (#278 / ADR-122 addendum b)", () => {
  it("island decorations MATCH the outer editor's for the same doc+caret (live, caret away)", () => {
    const island = dump(mk(islandExts("live"), DOC, AWAY));
    const outer = dump(mk(outerExts("live"), DOC, AWAY));
    expect(island.length).toBeGreaterThan(0); // something rendered (marker hidden / styled)
    expect(island).toEqual(outer);
  });

  it("island reveal-on-caret MATCHES the outer editor (live, caret on the heading)", () => {
    const island = dump(mk(islandExts("live"), DOC, ON));
    const outer = dump(mk(outerExts("live"), DOC, ON));
    expect(island).toEqual(outer);
    // and reveal actually changed something vs caret-away (the parity above isn't vacuous)
    expect(island).not.toEqual(dump(mk(islandExts("live"), DOC, AWAY)));
  });

  it("island WYSIWYG never reveals markers (#164 invariant, same as outer)", () => {
    const onCaret = dump(mk(islandExts("wysiwyg"), DOC, ON));
    const away = dump(mk(islandExts("wysiwyg"), DOC, AWAY));
    expect(onCaret).toEqual(away); // caret position must not reveal syntax in wysiwyg
    expect(onCaret).toEqual(dump(mk(outerExts("wysiwyg"), DOC, ON))); // and it matches the outer surface
  });

  it("nested env pins vim/displayMode as facets (the island has no Compartments)", () => {
    const s = mk(islandExts("wysiwyg"), DOC, 0);
    expect(s.facet(displayMode)).toBe("wysiwyg");
    expect(s.facet(vimEnabled)).toBe(false);
  });

  it("nested and outer carry the SAME layer pieces by identity; block drag is outer-only", () => {
    const contains = (x: Extension, target: Extension): boolean =>
      x === target || (Array.isArray(x) && (x as Extension[]).some((e) => contains(e, target)));
    const nested = islandLayer("live");
    const outer = buildLivePreviewExtensions({}, { nested: false });
    for (const piece of [livePreview, macroEdit, mathField, listEditing, deadLinks, blockAnchors, blockEntry]) {
      expect(contains(nested, piece)).toBe(true);
      expect(contains(outer, piece)).toBe(true);
    }
    // page-structure reorder is a page affordance — never inside an island
    expect(contains(nested, blockDrag)).toBe(false);
    expect(contains(outer, blockDrag)).toBe(true);
  });

  it("single Y.Text: a nested mount is NOT collab-bound — remote edits don't enter, its edits don't leave", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "slot body");
    // the island seeds from a string snapshot (like mountSlotEditIsland) — no yCollab in the nested layer
    const view = new EditorView({ state: mk(islandExts("live"), ytext.toString(), 0) });
    ytext.insert(0, "REMOTE "); // a collaborator writes the page while the island is open
    expect(view.state.doc.toString()).toBe("slot body"); // …and the island does NOT see it live
    view.dispatch({ changes: { from: 0, insert: "typed " } }); // the user types in the island
    expect(ytext.toString()).toBe("REMOTE slot body"); // …and the Y.Text is untouched (commit is on blur, elsewhere)
    view.destroy();
  });
});
