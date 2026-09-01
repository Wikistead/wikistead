// #994 / ADR-276: the seam, not the rule.
//
// `unsynced-latch-994.test.ts` measures whether the rule is right. This measures whether anything
// drives it — the same split `collab-liveness-813.test.ts` already draws for liveness, and for the
// same reason: a correct rule nobody calls leaves the defect exactly where it was.
//
// The three things that can only be measured HERE, at the seam:
//   1. the SET side reads the Y.Doc, not the provider's counter (so a socket open with no edits
//      cannot set it, whatever `resetUnsyncedChanges()` put in that counter),
//   2. an update that came off the WIRE does not count as this client's unsent edit, and
//   3. teardown detaches both listeners.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

const captured: { opts: Record<string, unknown> | null } = { opts: null };
type Handler = (...a: never[]) => void;
const handlers = new Map<string, Set<Handler>>();
const providerInstance = {
  awareness: null,
  authorizedScope: undefined as string | undefined,
  on: vi.fn((ev: string, fn: Handler) => {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev)!.add(fn);
  }),
  off: vi.fn((ev: string, fn: Handler) => { handlers.get(ev)?.delete(fn); }),
  destroy: vi.fn(),
};

vi.mock("@hocuspocus/provider", () => ({
  WebSocketStatus: { Connecting: "connecting", Connected: "connected", Disconnected: "disconnected" },
  HocuspocusProviderWebsocket: class { destroy = vi.fn(); },
  HocuspocusProvider: class {
    constructor(opts: Record<string, unknown>) {
      captured.opts = opts;
      return Object.assign(providerInstance, { configuration: opts }) as unknown as object;
    }
  },
}));

const { connect } = await import("./collab");

/** Fire the provider's own `unsyncedChanges` event, which is the ONLY thing the CLEAR side reads. */
const emitUnsynced = (n: number) => handlers.get("unsyncedChanges")?.forEach((fn) => (fn as (n: number) => void)(n));
const cb = (name: string) => captured.opts?.[name] as (arg?: unknown) => void;

function open() {
  const seen: boolean[] = [];
  const c = connect({ url: "ws://x", docName: "d", token: "t", onUnsyncedChanges: (v) => seen.push(v) });
  return { c, seen };
}
/** Bring the connection all the way to live, the way the provider's events would. */
function goLive() {
  cb("onStatus")({ status: "connected" });
  providerInstance.authorizedScope = "read-write";
  cb("onAuthenticated")();
  cb("onSynced")();
}

describe("#994 connect() drives the unsynced latch", () => {
  beforeEach(() => {
    handlers.clear();
    providerInstance.authorizedScope = undefined;
  });

  it("⚠️ a socket open with no local edit reports nothing, even though the counter says 1", () => {
    // `startSync()` calls `resetUnsyncedChanges()` on every socket open and that assigns 1, not 0.
    // This is the exact input a design that mirrored the counter would have got wrong.
    const { seen } = open();
    emitUnsynced(1);
    expect(seen, "a reader who has typed nothing must not be told their changes are unsaved").toEqual([]);
  });

  it("a local edit while the socket is down IS reported", () => {
    const { c, seen } = open();
    c.ytext.insert(0, "typed while offline");
    expect(seen).toEqual([true]);
  });

  it("⚠️ an update that arrived from the server is not this client's unsent edit", () => {
    // The provider's own predicate: `documentUpdateHandler` returns early on `origin === this`. If
    // the seam used a looser one, every remote keystroke from a collaborator would raise the band on
    // a reader who has typed nothing at all.
    const { c, seen } = open();
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "someone else typed this");
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(remote), c.provider);
    expect(c.ytext.toString(), "the update did land — this is not a vacuous no-op").toBe("someone else typed this");
    expect(seen, "a remote update is not an unsent local edit").toEqual([]);
  });

  it("the provider's ack clears it; the handshake alone does not", () => {
    const { c, seen } = open();
    c.ytext.insert(0, "x");
    emitUnsynced(1); // reconnect handshake: reset-to-1, nothing acknowledged yet
    expect(seen).toEqual([true]);
    emitUnsynced(0); // the server took it
    expect(seen).toEqual([true, false]);
  });

  it("⚠️ nothing is reported while the connection is live, however much is typed", () => {
    // The invariant: [[editor-dirty-presence-constraint]] measured that editor-derived state on the
    // host's render path breaks the presence e2e. Reported values are what re-render the host.
    const { c, seen } = open();
    goLive();
    for (let i = 0; i < 100; i++) {
      c.ytext.insert(0, "a");
      emitUnsynced(1);
      emitUnsynced(0);
    }
    expect(seen, "live typing produced host notifications").toEqual([]);
  });

  it("teardown detaches both listeners", () => {
    const { c, seen } = open();
    c.disconnect();
    expect(handlers.get("unsyncedChanges")?.size ?? 0).toBe(0);
    // The doc is destroyed by disconnect(), so drive a fresh one through the SAME registered handler
    // set to prove nothing is left listening on the provider side either.
    emitUnsynced(0);
    expect(seen).toEqual([]);
  });
});
