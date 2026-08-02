// #588: the keyboard rules for the @mention list.
//
// Pinned here rather than in the browser because the e2e tenant seats exactly ONE page-viewer, so a
// real browser can open the list and confirm a row but cannot demonstrate moving between rows —
// creating a second member means the whole invite-accept flow in a second browser context. The e2e
// spec covers what only a browser can (the keys reach the textarea at all, Enter inserts, Escape
// closes, and a CLOSED list leaves Enter to the composer); this covers where the highlight lands and
// which keys the composer must not swallow.
import { describe, it, expect } from "vitest";
import { classifyMentionKey, nextMentionIndex, classifyComposerKey } from "./mention-nav";

const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
  classifyMentionKey({ key: k, ctrlKey: !!mods.ctrlKey, shiftKey: !!mods.shiftKey });

describe("#588: which keys the mention list takes", () => {
  it("Ctrl-j / Ctrl-k and the arrows move it, in the same directions", () => {
    expect(key("j", { ctrlKey: true })).toEqual({ action: "move", delta: 1 });
    expect(key("ArrowDown")).toEqual({ action: "move", delta: 1 });
    expect(key("k", { ctrlKey: true })).toEqual({ action: "move", delta: -1 });
    expect(key("ArrowUp")).toEqual({ action: "move", delta: -1 });
  });

  it("a bare j or k is typing, not navigation", () => {
    // the whole point of the Ctrl modifier: this list lives inside a text field
    expect(key("j")).toEqual({ action: "pass" });
    expect(key("k")).toEqual({ action: "pass" });
  });

  it("Enter confirms, but Shift+Enter is still a newline", () => {
    expect(key("Enter")).toEqual({ action: "confirm" });
    expect(key("Enter", { shiftKey: true }), "a multi-line comment stays writable").toEqual({ action: "pass" });
  });

  it("Escape closes", () => {
    expect(key("Escape")).toEqual({ action: "close" });
  });

  it("Tab is left alone — it is the only keyboard way out of the composer", () => {
    expect(key("Tab")).toEqual({ action: "pass" });
  });

  it("Ctrl-n and Ctrl-p are not used (the browser has them)", () => {
    // ADR-018's reason for choosing j/k, restated where someone might undo it
    expect(key("n", { ctrlKey: true })).toEqual({ action: "pass" });
    expect(key("p", { ctrlKey: true })).toEqual({ action: "pass" });
  });
});

describe("#588: where the highlight lands", () => {
  it("wraps at both ends", () => {
    expect(nextMentionIndex(2, 3, 1), "past the last row → the first").toBe(0);
    expect(nextMentionIndex(0, 3, -1), "before the first → the last").toBe(2);
  });

  it("moves one at a time in the middle", () => {
    expect(nextMentionIndex(0, 3, 1)).toBe(1);
    expect(nextMentionIndex(2, 3, -1)).toBe(1);
  });

  it("a list of one stays put rather than going out of range", () => {
    expect(nextMentionIndex(0, 1, 1)).toBe(0);
    expect(nextMentionIndex(0, 1, -1)).toBe(0);
  });

  it("an empty list answers 0 rather than NaN", () => {
    // reachable in the frame between a query change and the new suggestions arriving
    expect(nextMentionIndex(3, 0, 1)).toBe(0);
  });
});

// #594 (user ruling): Enter posts, Shift-Enter breaks the line — the chat convention, chosen over the
// document one (GitHub/Jira: Enter breaks, Ctrl-Enter posts).
//
// The IME case is why this is a value and not three lines inside a handler. Confirming a Japanese
// conversion candidate IS an Enter keydown; posting on it sends the comment mid-word every single time,
// which makes the composer unusable in Japanese, Chinese and Korean alike. A real IME cannot be driven
// from a browser test, so the rule is proved here with the flag the browser sets, and the e2e covers
// what only a browser can.
describe("#594: what Enter does in the comment composer", () => {
  it("posts", () => {
    expect(classifyComposerKey({ key: "Enter", shiftKey: false })).toEqual({ action: "submit" });
  });

  it("breaks the line with Shift", () => {
    expect(classifyComposerKey({ key: "Enter", shiftKey: true })).toEqual({ action: "newline" });
  });

  it("does NOT post while an IME conversion is being confirmed", () => {
    expect(classifyComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toEqual({ action: "newline" });
    // the older browsers' way of saying the same thing
    expect(classifyComposerKey({ key: "Enter", shiftKey: false, keyCode: 229 })).toEqual({ action: "newline" });
  });

  it("posts on the Enter AFTER the conversion is confirmed", () => {
    // the sequence that matters: compositionend clears the flag, and the next Enter is an ordinary one
    expect(classifyComposerKey({ key: "Enter", shiftKey: false, isComposing: false })).toEqual({ action: "submit" });
  });

  it("accepts the modifier a Mac user arrives with", () => {
    expect(classifyComposerKey({ key: "Enter", shiftKey: false, metaKey: true })).toEqual({ action: "submit" });
    expect(classifyComposerKey({ key: "Enter", shiftKey: false, ctrlKey: true })).toEqual({ action: "submit" });
  });

  it("leaves every other key to the textarea", () => {
    for (const key of ["a", "Escape", "ArrowDown", "Tab"]) {
      expect(classifyComposerKey({ key, shiftKey: false }), key).toEqual({ action: "newline" });
    }
  });
});
