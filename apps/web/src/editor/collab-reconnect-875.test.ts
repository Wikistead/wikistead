// @vitest-environment happy-dom
//
// #875 (review rejection): the knock has to reach the session, and stop reaching it.
//
// `guest-session-retry-875.test.ts` measures the backoff. This measures the OTHER half — that
// `connect()` hands the session something that actually re-attaches this document, and takes it back
// when the document goes away. Measured: with only the session half pinned, deleting the unregister
// from `disconnect()` left every case green, and a delay firing after teardown would then reconnect a
// provider the editor had already thrown away.
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured: { opts: Record<string, unknown> | null } = { opts: null };
const providerInstance = {
  awareness: null,
  authorizedScope: undefined as string | undefined,
  on: vi.fn(), off: vi.fn(), destroy: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
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

describe("#875 connect() hands the session its knock", () => {
  let registered: ((() => void) | null)[];

  beforeEach(() => {
    registered = [];
    providerInstance.connect.mockClear();
  });

  it("registers a knock that re-attaches THIS document", () => {
    const c = connect({ url: "ws://x", docName: "d", token: "t", registerReconnect: (fn) => registered.push(fn) });
    expect(registered.filter(Boolean).length, "the session was handed nothing to knock with").toBe(1);
    registered.find(Boolean)!();
    // `provider.connect()` is what re-attaches a document the provider detached; nothing else does.
    expect(providerInstance.connect).toHaveBeenCalledTimes(1);
    c.disconnect();
  });

  it("takes the knock back when the connection is torn down", () => {
    const c = connect({ url: "ws://x", docName: "d", token: "t", registerReconnect: (fn) => registered.push(fn) });
    c.disconnect();
    expect(registered.at(-1), "a delay firing after teardown would reconnect a discarded provider").toBeNull();
  });

  it("is optional — the member surface and the ephemeral room pass none", () => {
    expect(() => connect({ url: "ws://x", docName: "d", token: "t" }).disconnect()).not.toThrow();
  });
});
