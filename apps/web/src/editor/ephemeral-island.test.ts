import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { shouldSeed, seedEphemeralBodyOnce, ephemeralBody, isSeeded } from "./ephemeral-island";

// #502 / ADR-184 slice 2: the seed-once "sharp edge". A Y.Text is an APPEND type, so two peers seeding the
// co-occupied island body from the fence would DOUBLE it. These pins gate the single-writer election + the
// seeded-guard that make exactly one insert run, verified against real synced Y.Docs (pure Yjs — no DOM).

// Deterministic clientIDs: Y.Doc assigns a random clientID; pin it before any content so the election is
// reproducible (Yjs uses clientID from the first write onward — assigning pre-content is safe).
function docWithClientID(id: number): Y.Doc {
  const d = new Y.Doc();
  d.clientID = id;
  return d;
}

describe("shouldSeed (#502 single-seeder election)", () => {
  it("elects the LOWEST clientID present", () => {
    expect(shouldSeed(5, [5, 9])).toBe(true); // 5 is the min → eligible
    expect(shouldSeed(9, [5, 9])).toBe(false); // 9 is not the min → not eligible
    expect(shouldSeed(3, [3, 5, 9])).toBe(true);
    expect(shouldSeed(5, [3, 5, 9])).toBe(false);
  });

  it("elects no one on an empty roster (seeding waits for observed co-occupancy)", () => {
    expect(shouldSeed(5, [])).toBe(false);
  });
});

describe("seedEphemeralBodyOnce (#502 seed-once guard)", () => {
  it("the elected seeder seeds an empty body once and sets the guard", () => {
    const doc = docWithClientID(5);
    expect(seedEphemeralBodyOnce(doc, 5, [5, 9], "graph TD")).toBe(true);
    expect(ephemeralBody(doc).toString()).toBe("graph TD");
    expect(isSeeded(doc)).toBe(true);
  });

  it("a NON-elected peer never seeds (returns false, body stays empty)", () => {
    const doc = docWithClientID(9);
    expect(seedEphemeralBodyOnce(doc, 9, [5, 9], "graph TD")).toBe(false);
    expect(ephemeralBody(doc).toString()).toBe("");
    expect(isSeeded(doc)).toBe(false);
  });

  it("a late joiner never re-seeds once the guard is set (idempotent bind)", () => {
    const doc = docWithClientID(3); // would be the new min, but the body is already seeded
    doc.getMap("meta").set("seeded", true);
    doc.getText("body").insert(0, "graph TD"); // the already-synced seeded body
    expect(seedEphemeralBodyOnce(doc, 3, [3, 5, 9], "graph TD")).toBe(false); // guard blocks re-seed
    expect(ephemeralBody(doc).toString()).toBe("graph TD"); // NOT doubled
  });

  it("never appends onto a non-empty body even if the guard is somehow unset (defensive)", () => {
    const doc = docWithClientID(5);
    doc.getText("body").insert(0, "graph TD"); // body has text but guard is unset
    seedEphemeralBodyOnce(doc, 5, [5, 9], "graph TD");
    expect(ephemeralBody(doc).toString()).toBe("graph TD"); // the length guard blocked the append
    expect(isSeeded(doc)).toBe(true); // but the doc is now marked seeded
  });

  it("two co-occupants that seed WHILE DIVERGED converge to the body EXACTLY ONCE (no doubling)", () => {
    // This is the true doubling pin (design-review of 2a). The hazard is two peers each inserting the
    // fence text into the SHARED append-type body BEFORE their updates have synced — which merges to
    // "graph TDgraph TD". So seed both docs while still DIVERGED (no live wiring), THEN sync. With the
    // election intact only the elected (min clientID) peer inserts, so the merge is len 8; if the election
    // were broken both would insert while diverged and the post-sync body would be len 16 → RED. (A live-
    // sync-first variant would instead let the guard sync in and mask a broken election — that is the
    // vacuous shape this replaces: it tests convergence, not doubling.)
    const a = docWithClientID(5); // elected
    const b = docWithClientID(9); // not elected
    const roster = [5, 9];
    const seededA = seedEphemeralBodyOnce(a, 5, roster, "graph TD"); // diverged — not yet synced
    const seededB = seedEphemeralBodyOnce(b, 9, roster, "graph TD"); // diverged — not yet synced
    expect(seededA).toBe(true);
    expect(seededB).toBe(false);
    // Now exchange state both ways (the ephemeral room's relay).
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(ephemeralBody(a).toString()).toBe("graph TD");
    expect(ephemeralBody(b).toString()).toBe("graph TD");
    expect(ephemeralBody(a).length).toBe(8); // 8, not 16 — broken election → both insert diverged → 16
    expect(ephemeralBody(b).length).toBe(8);
  });
});
