import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { shouldReplace, writeLocalElements, readSceneElements, reconcile, type ExElement } from "./excalidraw-collab";

// #92 / ADR-093: the version-based Excalidraw reconcile core. Concurrent edits converge deterministically
// (higher version wins, versionNonce breaks ties); deletions propagate as isDeleted tombstones and are
// not resurrected by stale inserts; merge is order-independent. Distinct pass/fail values throughout.
const el = (id: string, version: number, extra: Partial<ExElement> = {}): ExElement => ({ id, version, versionNonce: version * 10, ...extra });

describe("shouldReplace (version rule)", () => {
  it("replaces when there is nothing, or the incoming version is higher", () => {
    expect(shouldReplace(undefined, el("a", 1))).toBe(true);
    expect(shouldReplace(el("a", 1), el("a", 2))).toBe(true);
    expect(shouldReplace(el("a", 3), el("a", 2))).toBe(false); // older incoming loses
  });
  it("breaks a version tie by the higher versionNonce (stable, symmetric)", () => {
    expect(shouldReplace({ id: "a", version: 5, versionNonce: 100 }, { id: "a", version: 5, versionNonce: 200 })).toBe(true);
    expect(shouldReplace({ id: "a", version: 5, versionNonce: 200 }, { id: "a", version: 5, versionNonce: 100 })).toBe(false);
  });
});

describe("writeLocalElements + readSceneElements (Y.Map merge)", () => {
  it("two clients' concurrent edits converge by version; the higher version wins", () => {
    const shared = new Y.Doc();
    // client A writes version 2 of 'x'; client B writes version 3 of 'x' (B is newer)
    writeLocalElements(shared, [el("x", 2, { text: "A" })]);
    writeLocalElements(shared, [el("x", 3, { text: "B" })]);
    const scene = readSceneElements(shared);
    expect(scene).toHaveLength(1);
    expect(scene[0]!.text).toBe("B"); // higher version wins
    // a stale re-write of the OLD version does not clobber the newer one
    expect(writeLocalElements(shared, [el("x", 1, { text: "stale" })])).toBe(0); // nothing written
    expect(readSceneElements(shared)[0]!.text).toBe("B");
  });

  it("re-syncs an element MUTATED IN PLACE — a freedraw stroke grows its points on the SAME ref (#92)", () => {
    // The bounce bug: Excalidraw mutates the same element object as a stroke grows (points += , version++).
    // Storing the live reference made map.get(id)===incoming, so the version always tied and only the
    // first write (the stroke's START point) ever synced. Snapshotting decouples them.
    const shared = new Y.Doc();
    const live: ExElement = { id: "f", version: 1, versionNonce: 10, points: [[0, 0]] };
    expect(writeLocalElements(shared, [live])).toBe(1); // first write = the stroke's start point
    // Excalidraw grows the SAME object as the freedraw continues:
    live.points = [[0, 0], [1, 1], [2, 2]];
    live.version = 2; live.versionNonce = 20;
    expect(writeLocalElements(shared, [live])).toBe(1); // MUST re-sync (was 0 = the bug: never propagated)
    expect(readSceneElements(shared)[0]!.points).toEqual([[0, 0], [1, 1], [2, 2]]); // growth reached the map
    // snapshot decoupling: mutating the live ref AFTER a write does not silently alter the stored copy
    (live.points as number[][]).push([3, 3]);
    expect(readSceneElements(shared)[0]!.points).toEqual([[0, 0], [1, 1], [2, 2]]); // still the snapshot
  });

  it("a delete (isDeleted) tombstone drops the element from the scene and is not resurrected", () => {
    const shared = new Y.Doc();
    writeLocalElements(shared, [el("y", 1, { text: "keep" }), el("z", 1, { text: "gone" })]);
    writeLocalElements(shared, [el("z", 2, { isDeleted: true })]); // delete z (newer version)
    const scene = readSceneElements(shared);
    expect(scene.map((e) => e.id)).toEqual(["y"]); // z hidden
    // a stale insert of z at the OLD version must NOT bring it back
    expect(writeLocalElements(shared, [el("z", 1, { text: "gone" })])).toBe(0);
    expect(readSceneElements(shared).map((e) => e.id)).toEqual(["y"]);
  });
});

describe("reconcile (order-independent convergence)", () => {
  it("merge(a,b) === merge(b,a) as an element set (deterministic)", () => {
    const a = [el("p", 2, { t: "a2" }), el("q", 1)];
    const b = [el("p", 1, { t: "b1" }), el("r", 1)];
    const ab = reconcile(a, b).sort((x, y) => x.id.localeCompare(y.id));
    const ba = reconcile(b, a).sort((x, y) => x.id.localeCompare(y.id));
    expect(ab).toEqual(ba);
    expect(ab.find((e) => e.id === "p")!.t).toBe("a2"); // p@v2 wins over p@v1 either way
    expect(ab.map((e) => e.id)).toEqual(["p", "q", "r"]);
  });
});
