import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { IslandCoEditController, type CoEditDeps } from "./island-coedit-controller";
import { ephemeralBody } from "./ephemeral-island";

// #502 / ADR-184 slice 2b-2b-ii: the co-edit lifecycle controller's DECISION logic — lazy spin-up on 2+,
// seed after sync, flush + teardown on drop below 2. Pinned in isolation with fakes (the DOM re-mount the
// bind/unbind callbacks drive is the device-visual part, gated on a 2-client review).

function fakeAwareness(clientID: number) {
  const states = new Map<number, Record<string, unknown>>();
  const listeners = new Set<() => void>();
  return {
    clientID,
    states,
    setLocalStateField() {},
    getStates: () => states,
    on: (_e: "change", cb: () => void) => { listeners.add(cb); },
    off: (_e: "change", cb: () => void) => { listeners.delete(cb); },
    fire: () => listeners.forEach((cb) => cb()),
    occupy: (id: number, anchor: string) => states.set(id, { macroEdit: anchor }),
    leave: (id: number) => states.delete(id),
  };
}

// A fake ephemeral session: a REAL Y.Doc (so seed/flush operate on genuine Yjs), a manual sync trigger, and
// a destroy spy — enough for the controller's lifecycle without a live provider.
function fakeSessionFactory() {
  const created: { doc: Y.Doc; destroy: ReturnType<typeof vi.fn>; sync: () => void }[] = [];
  const connect = vi.fn(() => {
    const doc = new Y.Doc();
    let onSyncedCb: (() => void) | null = null;
    const sess = { doc, awareness: {} as unknown, onSynced: (cb: () => void) => { onSyncedCb = cb; }, destroy: vi.fn() };
    created.push({ doc, destroy: sess.destroy, sync: () => onSyncedCb?.() });
    return sess as unknown as import("./collab").EphemeralSession;
  });
  return { connect, created };
}

function mkDeps(aw: ReturnType<typeof fakeAwareness>, factory: ReturnType<typeof fakeSessionFactory>, over: Partial<CoEditDeps> = {}): CoEditDeps {
  return {
    awareness: aw,
    anchor: "10",
    fenceText: () => "graph TD",
    connect: factory.connect,
    onBind: vi.fn(),
    onUnbind: vi.fn(),
    ...over,
  };
}

describe("IslandCoEditController (#502 co-edit lifecycle)", () => {
  it("a LONE occupant spins up NO ephemeral session (ADR §3 zero-cost)", () => {
    const aw = fakeAwareness(5);
    aw.occupy(5, "10"); // only self in island 10
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    expect(factory.connect).not.toHaveBeenCalled();
    expect(deps.onBind).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it("opening INTO an already-co-occupied anchor spins up, seeds after sync, and binds", () => {
    const aw = fakeAwareness(5); // self is the min clientID → the elected seeder
    aw.occupy(5, "10");
    aw.occupy(9, "10"); // a peer already in the same island
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    expect(factory.connect).toHaveBeenCalledTimes(1); // co-occupied at construct → spun up
    expect(deps.onBind).not.toHaveBeenCalled(); // ...but NOT bound until sync completes
    factory.created[0]!.sync();
    expect(deps.onBind).toHaveBeenCalledTimes(1);
    expect(ephemeralBody(factory.created[0]!.doc).toString()).toBe("graph TD"); // seeded once by the elected peer
    ctrl.dispose();
  });

  it("occupancy 1→2 spins up; 2→1 flushes the shared body back and tears down", () => {
    const aw = fakeAwareness(5);
    aw.occupy(5, "10");
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    expect(factory.connect).not.toHaveBeenCalled(); // lone → no session

    aw.occupy(9, "10"); aw.fire(); // a 2nd peer joins
    expect(factory.connect).toHaveBeenCalledTimes(1);
    factory.created[0]!.sync();
    expect(deps.onBind).toHaveBeenCalledTimes(1);
    // simulate a co-edit landing in the shared body before the peer leaves
    ephemeralBody(factory.created[0]!.doc).insert(8, " extra");

    aw.leave(9); aw.fire(); // the peer leaves → occupancy drops to 1
    expect(deps.onUnbind).toHaveBeenCalledTimes(1);
    expect((deps.onUnbind as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("graph TD extra"); // flushed body
    expect(factory.created[0]!.destroy).toHaveBeenCalledTimes(1); // session disposed
    ctrl.dispose();
  });

  it("a peer leaving BEFORE sync tears down WITHOUT an empty flush (no canon wipe)", () => {
    // Real providers sync asynchronously: a session can be spun up but not yet synced/bound when the peer
    // leaves. Its body is empty — flushing "" would make the host wipe the canonical fence body. tearDown
    // must NOT onUnbind an unbound session; it must only destroy it. (design-review must-fix.)
    const aw = fakeAwareness(5);
    aw.occupy(5, "10");
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    aw.occupy(9, "10"); aw.fire(); // 2nd peer joins → spinUp (onSynced registered, NOT yet fired)
    expect(factory.connect).toHaveBeenCalledTimes(1);
    aw.leave(9); aw.fire(); // peer leaves BEFORE sync completes
    expect(deps.onBind).not.toHaveBeenCalled(); // never bound
    expect(deps.onUnbind).not.toHaveBeenCalled(); // ...so NO empty flush (was a canon-wipe bug)
    expect(factory.created[0]!.destroy).toHaveBeenCalledTimes(1); // session still disposed (no leak)
    // a late sync after teardown must not bind a dead session either
    factory.created[0]!.sync();
    expect(deps.onBind).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it("dispose BEFORE sync (opened into co-occupancy, closed fast) does not empty-flush", () => {
    const aw = fakeAwareness(5);
    aw.occupy(5, "10"); aw.occupy(9, "10"); // co-occupied at construct → spinUp immediately
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    expect(factory.connect).toHaveBeenCalledTimes(1);
    ctrl.dispose(); // closed before the initial sync
    expect(deps.onUnbind).not.toHaveBeenCalled(); // unbound → no empty flush
    expect(factory.created[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  // #502 review follow-up (a): a NON-seeder can reach its own `synced` before the seeder's text replicates.
  // Binding then would hand the editor an EMPTY shared body, and since blur is the commit trigger, any blur
  // in that window writes the emptiness over the canonical text. Wait for content instead.
  it("a NON-seeder that syncs before the seed arrives does NOT bind until the body has content", () => {
    const aw = fakeAwareness(99);          // 99 > 1 ⇒ the peer (1) is the elected seeder, not us
    aw.occupy(99, "10"); aw.occupy(1, "10");
    const f = fakeSessionFactory();
    const onBind = vi.fn();
    const ctrl = new IslandCoEditController(mkDeps(aw, f, { onBind }));
    f.created[0]!.sync();                  // our provider synced — but the seed has NOT replicated yet
    expect(ephemeralBody(f.created[0]!.doc).length, "we are not the seeder, so the body is still empty").toBe(0);
    expect(onBind, "binding to an empty body is what emptied the canon — must not happen").not.toHaveBeenCalled();

    // the seeder's text arrives
    const body = ephemeralBody(f.created[0]!.doc);
    f.created[0]!.doc.transact(() => body.insert(0, "graph TD"));
    expect(onBind, "now there is something to bind to").toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  it("a torn-down session stops waiting for a seed (no observer left behind, no late bind)", () => {
    const aw = fakeAwareness(99);
    aw.occupy(99, "10"); aw.occupy(1, "10");
    const f = fakeSessionFactory();
    const onBind = vi.fn();
    const onUnbind = vi.fn();
    const ctrl = new IslandCoEditController(mkDeps(aw, f, { onBind, onUnbind }));
    f.created[0]!.sync();                  // waiting for the seed
    aw.leave(1); aw.fire();                // the peer leaves first → tearDown while still waiting
    expect(onUnbind, "never bound ⇒ no empty flush (the shipped guard)").not.toHaveBeenCalled();

    const body = ephemeralBody(f.created[0]!.doc);
    f.created[0]!.doc.transact(() => body.insert(0, "late"));
    expect(onBind, "a late seed must not resurrect a dead session's bind").not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it("does not double-spin-up while a session is already live", () => {
    const aw = fakeAwareness(5);
    aw.occupy(5, "10"); aw.occupy(9, "10");
    const factory = fakeSessionFactory();
    const ctrl = new IslandCoEditController(mkDeps(aw, factory));
    aw.occupy(7, "10"); aw.fire(); // a 3rd peer joins — still co-occupied, session already live
    expect(factory.connect).toHaveBeenCalledTimes(1); // NOT re-connected
    ctrl.dispose();
  });

  it("dispose() while bound flushes + destroys the session", () => {
    const aw = fakeAwareness(5);
    aw.occupy(5, "10"); aw.occupy(9, "10");
    const factory = fakeSessionFactory();
    const deps = mkDeps(aw, factory);
    const ctrl = new IslandCoEditController(deps);
    factory.created[0]!.sync();
    ctrl.dispose();
    expect(deps.onUnbind).toHaveBeenCalledTimes(1); // flushed on close
    expect(factory.created[0]!.destroy).toHaveBeenCalledTimes(1);
  });
});
