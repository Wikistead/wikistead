import { describe, it, expect, vi } from "vitest";
import { makeMacroPresence, coOccupantClientIDs, isIslandCoOccupied, isPeerEditingIsland, type AwarenessLike } from "./macro-presence";

// #92 presence: the page-awareness bridge for "editing a macro's modal". A fake AwarenessLike lets us
// assert the peer filtering (self excluded; only remote states carrying BOTH a macroEdit anchor and a
// user), that set() publishes the additive field, and that subscribe wires/unwires the change event.
function fakeAwareness(clientID: number, states: Record<number, Record<string, unknown>>): AwarenessLike & {
  fields: Record<string, unknown>; listeners: Set<() => void>;
} {
  const fields: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    clientID,
    fields,
    listeners,
    setLocalStateField(field, value) { fields[field] = value; },
    getStates() { return new Map(Object.entries(states).map(([k, v]) => [Number(k), v])); },
    on(_e, cb) { listeners.add(cb); },
    off(_e, cb) { listeners.delete(cb); },
  };
}

describe("makeMacroPresence (#92 presence bridge)", () => {
  it("peers() excludes self and returns remote editors with a macroEdit anchor + user", () => {
    const aw = fakeAwareness(1, {
      1: { macroEdit: "100", user: { name: "me", color: "#111" } }, // self → excluded
      2: { macroEdit: "250", user: { name: "Ann", color: "#f00" } }, // remote editor → included
      3: { user: { name: "Bob", color: "#0f0" } }, // remote but NOT editing a macro → excluded
      4: { macroEdit: "300" }, // editing but no user info → excluded
    });
    const peers = makeMacroPresence(aw).peers();
    expect(peers).toEqual([{ anchor: "250", name: "Ann", color: "#f00" }]);
  });

  it("set()/clear() are ADDITIVE — a pre-existing user (cursor) field is preserved (#92 regression)", () => {
    // The #92 regression: publishing macroEdit wiped the yCollab user/cursor field, so remote carets
    // stopped syncing. set() must only touch the macroEdit field, leaving `user` (and yCollab's cursor)
    // intact — through both set and clear.
    const aw = fakeAwareness(1, {});
    aw.setLocalStateField("user", { name: "me", color: "#111" }); // yCollab's cursor/user field
    aw.setLocalStateField("cursor", { anchor: 5, head: 5 });
    const p = makeMacroPresence(aw);
    p.set("42");
    expect(aw.fields["macroEdit"]).toBe("42");
    expect(aw.fields["user"]).toEqual({ name: "me", color: "#111" }); // preserved (not overwritten)
    expect(aw.fields["cursor"]).toEqual({ anchor: 5, head: 5 }); // cursor position survives
    p.set(null);
    expect(aw.fields["macroEdit"]).toBeNull();
    expect(aw.fields["user"]).toEqual({ name: "me", color: "#111" }); // still preserved after clear
    expect(aw.fields["cursor"]).toEqual({ anchor: 5, head: 5 });
  });

  it("subscribe() registers a change listener and the returned handle removes it", () => {
    const aw = fakeAwareness(1, {});
    const cb = vi.fn();
    const off = makeMacroPresence(aw).subscribe(cb);
    expect(aw.listeners.has(cb)).toBe(true);
    off();
    expect(aw.listeners.has(cb)).toBe(false);
  });
});

describe("coOccupantClientIDs / isIslandCoOccupied (#502 slice 2b — the seed roster)", () => {
  it("returns the clientIDs (INCLUDING self) publishing a given island anchor", () => {
    const aw = fakeAwareness(1, {
      1: { macroEdit: "42", user: { name: "me" } }, // self, in island 42
      2: { macroEdit: "42", user: { name: "Ann" } }, // peer, SAME island → co-occupant
      3: { macroEdit: "99", user: { name: "Bob" } }, // peer, a DIFFERENT island → excluded
      4: { user: { name: "Cara" } }, // peer, no island → excluded
    });
    expect(coOccupantClientIDs(aw, "42").sort()).toEqual([1, 2]); // self + Ann; NOT Bob(99) or Cara(none)
    expect(coOccupantClientIDs(aw, "99")).toEqual([3]); // only Bob
    expect(coOccupantClientIDs(aw, "7")).toEqual([]); // nobody in island 7
  });

  it("isIslandCoOccupied is true only with 2+ occupants (the ephemeral-doc spin-up gate)", () => {
    // A lone editor (self only) must NOT be co-occupied → no ephemeral doc spun up (ADR §3 zero-cost).
    const alone = fakeAwareness(1, { 1: { macroEdit: "42", user: { name: "me" } } });
    expect(isIslandCoOccupied(alone, "42")).toBe(false);
    // self + one peer in the same island → co-occupied.
    const shared = fakeAwareness(1, {
      1: { macroEdit: "42", user: { name: "me" } },
      2: { macroEdit: "42", user: { name: "Ann" } },
    });
    expect(isIslandCoOccupied(shared, "42")).toBe(true);
    // peers in a DIFFERENT island don't make MY island co-occupied.
    expect(isIslandCoOccupied(shared, "99")).toBe(false);
  });

  it("isPeerEditingIsland is the self-vs-PEER distinction (#502 co-edit floor)", () => {
    // Self alone on the macro → NOT a peer edit (opening the RichUI is safe — nobody to clobber).
    const alone = fakeAwareness(1, { 1: { macroEdit: "42", user: { name: "me" } } });
    expect(isPeerEditingIsland(alone, "42")).toBe(false);
    // Another client on the SAME macro → a peer IS editing → the RichUI would clobber → redirect to source.
    const withPeer = fakeAwareness(1, {
      1: { macroEdit: "42", user: { name: "me" } },
      2: { macroEdit: "42", user: { name: "Ann" } },
    });
    expect(isPeerEditingIsland(withPeer, "42")).toBe(true);
    // A peer on a DIFFERENT macro doesn't lock mine.
    expect(isPeerEditingIsland(withPeer, "99")).toBe(false);
  });
});
