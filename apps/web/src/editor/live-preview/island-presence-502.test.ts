// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  macroEdit,
  islandEditAnchor,
  setMacroRenderActive,
  setNestedEditActive,
  setSlotEditActive,
} from "./macro-edit";
import { macroPresence, type MacroPresence } from "./decorations";
import { macroPresencePublisher } from "../macro-presence-overlay";

// #502 / ADR-184 slice 1: text-body EDIT ISLANDS (a revealed macro body, a layout slot, a nested editUI
// island) publish their anchor onto page awareness so peers get the same #453 occupancy chip the Excalidraw
// MODAL already gives. These pins gate two guarantees: (1) islandEditAnchor derives the right anchor with
// the innermost island winning, and (2) the publisher writes ONLY the additive macroEdit field, ONLY on a
// real island transition — so it never fights the modal's own publish and never touches the sync path.

const mk = (doc: string) => EditorState.create({ doc, extensions: [macroEdit] });

describe("islandEditAnchor (#502 co-occupancy anchor)", () => {
  it("is null when no island is open", () => {
    expect(islandEditAnchor(mk("```mermaid\ngraph TD\n```"))).toBeNull();
  });

  it("returns the revealed-macro body anchor (macroRenderActiveField.from)", () => {
    const s = mk("```mermaid\ngraph TD\n```")
      .update({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: true }) }).state;
    expect(islandEditAnchor(s)).toBe("0");
  });

  it("returns the nested editUI island anchor (nestedEditActiveField.anchor)", () => {
    const s = mk("::::columns\n:::column\n```mermaid\nx\n```\n:::\n::::")
      .update({ effects: setNestedEditActive.of({ nested: { from: 22, to: 34 }, anchor: 28, container: { from: 0, to: 60 } }) }).state;
    expect(islandEditAnchor(s)).toBe("28");
  });

  it("returns the slot container anchor (slotEditField.container.from)", () => {
    const s = mk("::::columns\n:::column\nbody\n:::\n::::")
      .update({ effects: setSlotEditActive.of({ container: { from: 0, to: 34 }, index: 0 }) }).state;
    expect(islandEditAnchor(s)).toBe("0");
  });

  it("prefers the INNERMOST island: slot wins over a container's revealed-macro field", () => {
    // The two fields carry DIFFERENT anchors (slot container.from=0, revealed-macro from=11) so this
    // pin actually discriminates the check ORDER: slotEditField is read before macroRenderActiveField,
    // so "0" is returned. Reversing the order in islandEditAnchor would return "11" → this test goes RED.
    const s = mk("::::columns\n:::column\nbody\n:::\n::::")
      .update({ effects: [
        setMacroRenderActive.of({ from: 11, to: 34, raw: false }),
        setSlotEditActive.of({ container: { from: 0, to: 34 }, index: 1 }),
      ] }).state;
    expect(islandEditAnchor(s)).toBe("0");
  });
});

// A MacroPresence whose set() records the sequence of published anchors (the only method the publisher uses).
function recordingPresence(): MacroPresence & { calls: (string | null)[] } {
  const calls: (string | null)[] = [];
  return {
    calls,
    set(anchor) { calls.push(anchor); },
    peers() { return []; },
    subscribe() { return () => {}; },
  };
}

function mountPublisher(doc: string, presence: MacroPresence) {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [macroEdit, macroPresence.of(presence), macroPresencePublisher] }),
  });
}

describe("macroPresencePublisher (#502 additive island presence)", () => {
  it("does NOT publish on mount when no island is open (no spurious awareness write)", () => {
    const p = recordingPresence();
    const view = mountPublisher("```mermaid\ngraph TD\n```", p);
    expect(p.calls).toEqual([]);
    view.destroy();
  });

  it("publishes the anchor on island-open and clears it on close", () => {
    const p = recordingPresence();
    const view = mountPublisher("```mermaid\ngraph TD\n```\nafter", p);
    view.dispatch({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: true }) });
    expect(p.calls).toEqual(["0"]); // opened → published
    view.dispatch({ selection: { anchor: 27 } }); // caret leaves the block → field clears
    expect(p.calls).toEqual(["0", null]); // closed → cleared
    view.destroy();
  });

  it("writes ONLY on a real transition — never on unrelated updates (does not fight the modal)", () => {
    const p = recordingPresence();
    const view = mountPublisher("hello world\n\nmore text", p);
    // A doc edit and a selection move with NO island open must produce zero writes: while a modal owns the
    // macroEdit field, no island field is set, so the publisher stays silent and the modal's anchor stands.
    view.dispatch({ changes: { from: 5, insert: "X" }, selection: { anchor: 6 } });
    view.dispatch({ selection: { anchor: 2 } });
    expect(p.calls).toEqual([]);
    view.destroy();
  });

  it("clears a still-open island's anchor on surface teardown (no ghost chip on peers)", () => {
    const p = recordingPresence();
    const view = mountPublisher("::::columns\n:::column\nbody\n:::\n::::", p);
    view.dispatch({ effects: setSlotEditActive.of({ container: { from: 0, to: 34 }, index: 0 }) });
    expect(p.calls).toEqual(["0"]);
    view.destroy(); // surface torn down with the island still open
    expect(p.calls).toEqual(["0", null]);
  });
});
