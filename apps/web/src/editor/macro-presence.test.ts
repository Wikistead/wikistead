import { describe, it, expect, vi } from "vitest";
import { makeMacroPresence, type AwarenessLike } from "./macro-presence";

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

  it("set() publishes the additive macroEdit field (null clears it) without touching user", () => {
    const aw = fakeAwareness(1, {});
    const p = makeMacroPresence(aw);
    p.set("42");
    expect(aw.fields["macroEdit"]).toBe("42");
    expect(aw.fields["user"]).toBeUndefined(); // additive — never overwrites the cursor's user field
    p.set(null);
    expect(aw.fields["macroEdit"]).toBeNull();
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
