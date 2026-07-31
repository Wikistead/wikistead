// @vitest-environment happy-dom
// #565 bug 1: the fence-settings panel dismissed itself on the capture-phase document mousedown,
// which OUTRUNS blur — so a text control's native `change` (the commit event) never fired and a
// title typed with the mouse-close path was silently discarded. The pin drives the real panel in a
// real EditorView: type into File name, close by each gesture, and read the document.
//   - outside click  → the pending text COMMITS (this was red before the fix)
//   - ✕ button       → commits the same way
//   - Escape         → CANCELS (the one deliberate way to back out of a half-typed value)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { codeFenceSettingsPanel, openFenceSettings } from "./fence-settings-panel";

const DOC = "```\nconst a = 1\n```\n";

let view: EditorView;

beforeEach(() => {
  view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [codeFenceSettingsPanel()] }),
    parent: document.body,
  });
  view.dispatch({ effects: openFenceSettings.of(0) });
});

afterEach(() => {
  view.destroy();
  document.body.innerHTML = "";
});

const titleInput = (): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>('[data-testid="macro-setting-title"]');
  expect(el, "the panel is mounted in the tooltip layer").not.toBeNull();
  return el!;
};

// the outside-click listener attaches on a macrotask so the opening mousedown can't self-dismiss
const listenersAttached = () => new Promise((r) => setTimeout(r, 1));

describe("#565: pending text survives a mouse-close of the fence settings panel", () => {
  it("outside click commits the typed title before the panel goes down", async () => {
    await listenersAttached();
    const input = titleInput();
    input.focus();
    input.value = "AA";
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.doc.line(1).text).toContain('title="AA"');
    expect(document.querySelector('[data-testid="fence-settings-panel"]'), "panel closed").toBeNull();
  });

  it("the ✕ button commits the same way", async () => {
    await listenersAttached();
    const input = titleInput();
    input.focus();
    input.value = "BB";
    document.querySelector<HTMLButtonElement>('[data-testid="fence-settings-close"]')!.click();
    expect(view.state.doc.line(1).text).toContain('title="BB"');
  });

  it("Escape cancels the half-typed value", async () => {
    await listenersAttached();
    const input = titleInput();
    input.focus();
    input.value = "CC";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.state.doc.line(1).text).not.toContain("CC");
    expect(document.querySelector('[data-testid="fence-settings-panel"]'), "panel closed").toBeNull();
  });

  it("an unchanged value produces no document edit on close (the no-op guard)", async () => {
    await listenersAttached();
    titleInput().focus();
    const before = view.state.doc.toString();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
  });
});
