import { describe, it, expect } from "vitest";
import { resolvePresenceBlocks } from "./macro-presence-overlay";

// #92 comment 982 (②③): the pure fold of the two presence sources (modal-editing + remote caret) onto the
// macro block each occupies. Rendering (outline + avatar) is DOM/measure and covered by e2e; this pins the
// mapping + dedupe logic.
describe("resolvePresenceBlocks (#92 ②③ presence fold)", () => {
  const blocks = [{ from: 10, to: 40 }, { from: 60, to: 90 }];

  it("maps a modal peer by its anchor to the block whose `from` equals it", () => {
    const out = resolvePresenceBlocks([{ anchor: "10", name: "Ann", color: "#f00" }], [], blocks);
    expect([...out.keys()]).toEqual([10]);
    expect(out.get(10)).toEqual([{ name: "Ann", color: "#f00", key: "Ann:#f00" }]);
  });

  it("maps a remote caret to the block whose range contains its head", () => {
    const out = resolvePresenceBlocks([], [{ head: 72, name: "Bob", color: "#0f0", picture: null }], blocks);
    expect(out.get(60)).toEqual([{ name: "Bob", color: "#0f0", picture: null, key: "Bob:#0f0" }]);
  });

  it("dedupes a peer present via BOTH sources in the same block (one avatar, by identity)", () => {
    const out = resolvePresenceBlocks(
      [{ anchor: "10", name: "Ann", color: "#f00" }],
      [{ head: 20, name: "Ann", color: "#f00", picture: null }], // Ann also has a caret in block 10
      blocks,
    );
    expect(out.get(10)).toHaveLength(1); // deduped by name:color
  });

  it("keeps two DIFFERENT peers in the same block", () => {
    const out = resolvePresenceBlocks(
      [],
      [
        { head: 15, name: "Ann", color: "#f00", picture: null },
        { head: 30, name: "Bob", color: "#0f0", picture: null },
      ],
      blocks,
    );
    expect(out.get(10)).toHaveLength(2);
  });

  it("drops a caret / anchor that lands in no block (nothing to outline)", () => {
    const out = resolvePresenceBlocks(
      [{ anchor: "999", name: "X", color: "#00f" }],
      [{ head: 50, name: "Y", color: "#000", picture: null }], // 50 is between blocks
      blocks,
    );
    expect(out.size).toBe(0);
  });

  it("maps a modal anchor that CONTAINS (not equals) a block position, drift-tolerant", () => {
    const out = resolvePresenceBlocks([{ anchor: "25", name: "Ann", color: "#f00" }], [], blocks);
    expect(out.get(10)).toHaveLength(1); // 25 ∈ [10,40] → block 10
  });
});
