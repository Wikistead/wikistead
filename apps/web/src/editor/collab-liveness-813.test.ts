// #813 / ADR-248 §3.1: the seam, not the rule.
//
// `liveness-813.test.ts` measures whether the rule is right. This measures whether anything asks it.
// The defect was precisely a seam: `connect()` handed the provider a token and subscribed to none of
// its reports, so a socket refused five minutes ago looked exactly like a healthy one to everything
// above. A rule nobody calls would have left that untouched.
//
// The provider is replaced so its callbacks can be driven directly — including the READ-ONLY case,
// which by construction emits nothing at all and therefore cannot be reached any other way.
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured: { opts: Record<string, unknown> | null } = { opts: null };
const providerInstance = { awareness: null, authorizedScope: undefined as string | undefined, on: vi.fn(), off: vi.fn(), destroy: vi.fn() };

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

type Cb = (arg?: unknown) => void;
const cb = (name: string): Cb => {
  const fn = captured.opts?.[name] as Cb | undefined;
  expect(fn, `connect() does not pass ${name} to the provider — the report is discarded at the seam`).toBeTypeOf("function");
  return fn!;
};

describe("#813 connect() passes the provider's reports through", () => {
  let seen: { live: boolean; reason: string | null }[];

  beforeEach(() => {
    seen = [];
    providerInstance.authorizedScope = undefined;
    connect({ url: "ws://x", docName: "d", token: "t", onLiveness: (s) => seen.push(s as never) });
  });

  it("starts by saying the edits are NOT arriving", () => {
    // A surface that renders before the first network event must not open by claiming they are safe.
    expect(seen[0]).toEqual({ live: false, reason: "connecting" });
  });

  it("reaches live only after the server says read-write", () => {
    cb("onStatus")({ status: "connected" });
    providerInstance.authorizedScope = "read-write";
    cb("onAuthenticated")();
    expect(seen.at(-1)!.live, "synced has not arrived yet").toBe(false);
    cb("onSynced")();
    expect(seen.at(-1)).toEqual({ live: true, reason: null });
  });

  it("⚠️ a read-only connection completes every step and is never live", () => {
    // The case with no observable failure: the server takes the token, syncs the document, and then
    // silently discards every update. Nothing in the provider fires. Only the scope says so.
    cb("onStatus")({ status: "connected" });
    providerInstance.authorizedScope = "readonly";
    cb("onAuthenticated")();
    cb("onSynced")();
    expect(seen.at(-1)).toEqual({ live: false, reason: "read-only" });
  });

  it("a refused token is reported as unauthenticated, not as reconnecting", () => {
    cb("onStatus")({ status: "connected" });
    cb("onAuthenticationFailed")({ reason: "expired" });
    expect(seen.at(-1)).toEqual({ live: false, reason: "unauthenticated" });
  });

  it("a dropped socket is not live", () => {
    cb("onStatus")({ status: "connected" });
    providerInstance.authorizedScope = "read-write";
    cb("onAuthenticated")();
    cb("onSynced")();
    expect(seen.at(-1)!.live).toBe(true);
    cb("onStatus")({ status: "disconnected" });
    expect(seen.at(-1)).toEqual({ live: false, reason: "connecting" });
  });

  it("⚠️ and a socket that comes BACK is not live until it is authenticated again", () => {
    // This is where the state from the last connection is dangerous rather than merely stale. The
    // socket returning says nothing about whether the token was accepted this time — and a token
    // refused on reconnect is the reported accident itself. If the previous connection's
    // `authenticated` and `authorizedScope` were left standing, the moment the socket reappears the
    // client would call itself live and go on discarding the document.
    //
    // Measured, not assumed: the earlier "dropped socket" case does NOT catch this. `notLiveReason`
    // answers `connecting` from `!connected` before it ever looks at the scope, so a version that
    // kept the stale scope passed it. This drives the state that actually decides.
    cb("onStatus")({ status: "connected" });
    providerInstance.authorizedScope = "read-write";
    cb("onAuthenticated")();
    cb("onSynced")();
    cb("onStatus")({ status: "disconnected" });
    cb("onStatus")({ status: "connected" });
    expect(seen.at(-1), "a returning socket must not inherit the last connection's permission")
      .toEqual({ live: false, reason: "unauthenticated" });
  });

  it("reports only on CHANGE — the band is not a per-event store under the editor", () => {
    cb("onStatus")({ status: "connected" });
    providerInstance.authorizedScope = "read-write";
    cb("onAuthenticated")();
    cb("onSynced")();
    const n = seen.length;
    cb("onSynced")();
    cb("onSynced")();
    cb("onAuthenticated")();
    expect(seen.length, "a repeated event re-notified subscribers").toBe(n);
  });
});
