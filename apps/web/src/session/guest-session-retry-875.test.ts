// @vitest-environment happy-dom
//
// #875 (review rejection): somebody has to knock again.
//
// THE DEFECT: the token getter deliberately never throws, so a refresh it could not complete hands
// back the token it already holds; the server then closes the connection on its own terms. The
// provider does NOT come back from that — `permissionDeniedHandler` disconnects it — and the session
// only wrote "the next connection asks again". Nothing opened a next connection. A guest who hit the
// refresh rate limit once was off the socket until they reloaded the tab, still typing.
//
// ⚠️ WHY THE OBVIOUS TEST IS NOT ENOUGH: asserting that `renew()` returns `retry` passes on the broken
// build — it always did. The three things that have to hold are separate, so they are separate cases:
// the knock is DELIVERED, it WAITS first, and it eventually STOPS. An implementation missing any one
// of them satisfies the other two.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeGuestSession, RETRY_DELAYS_MS } from "./guest-session";
import type { GuestToken } from "../data/apiClient";

const tokenExpiringIn = (seconds: number): string => {
  const claims = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, anonId: "anon:abc" }))
    .replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${claims}.signature`;
};
const minted = (token: string): GuestToken => ({ token, docName: "t:x:p:1", capability: "edit", readOnly: false });

/** Collects what the session asked to wait for, and lets the case decide when time passes. */
function fakeClock() {
  const queued: { fn: () => void; ms: number }[] = [];
  // Every delay ever asked for, kept separately from the queue: firing one removes it, and the case
  // that checks the ladder has to see the whole ladder, not what is left of it.
  const asked: number[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { queued.push({ fn, ms }); asked.push(ms); },
    delays: () => [...asked],
    fire: () => { const q = queued.shift(); q?.fn(); },
    pending: () => queued.length,
  };
}

let refresh: ReturnType<typeof vi.fn>;
let exchange: ReturnType<typeof vi.fn>;
vi.mock("../data/apiClient", () => ({
  refreshGuestToken: (...a: unknown[]) => refresh(...a),
  fetchGuestToken: (...a: unknown[]) => exchange(...a),
}));

beforeEach(() => {
  refresh = vi.fn();
  exchange = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("#875 the session is the retrying party", () => {
  it("knocks on the socket again after a rate-limited refresh — the getter alone never would", () => {
    // Nothing about the return value changed between the broken build and this one. What changed is
    // that something happens afterwards.
    const clock = fakeClock();
    refresh.mockResolvedValue({ kind: "retry" });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    const reconnect = vi.fn();
    s.onReconnect(reconnect);

    return s.getToken().then(() => {
      expect(clock.pending(), "the session did not arrange to come back at all").toBe(1);
      expect(reconnect, "it must WAIT — knocking immediately is the rate limit again").not.toHaveBeenCalled();
      clock.fire();
      expect(reconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("waits longer each time, and stops — an endless retry is another kind of silence", async () => {
    const clock = fakeClock();
    refresh.mockResolvedValue({ kind: "retry" });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    s.onReconnect(() => {});
    for (let i = 0; i < RETRY_DELAYS_MS.length + 2; i++) { await s.getToken(); clock.fire(); }
    expect(clock.delays()).toEqual(RETRY_DELAYS_MS);
    expect(s.retriesLeft(), "the ladder is spent and the session stops knocking").toBe(0);
    // ...and it really has stopped: another failure adds nothing.
    await s.getToken();
    expect(clock.delays()).toEqual(RETRY_DELAYS_MS);
  });

  it("a refresh that worked buys the ladder back", async () => {
    const clock = fakeClock();
    refresh.mockResolvedValueOnce({ kind: "retry" })
      .mockResolvedValueOnce({ kind: "renewed", minted: minted(tokenExpiringIn(600)) });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    s.onReconnect(() => {});
    await s.getToken();
    expect(s.retriesLeft()).toBe(RETRY_DELAYS_MS.length - 1);
    await s.getToken();
    expect(s.retriesLeft(), "a good stretch must not be paid for by the last bad one").toBe(RETRY_DELAYS_MS.length);
  });

  it("does not knock once the session is genuinely over", async () => {
    const clock = fakeClock();
    refresh.mockResolvedValue({ kind: "ended", why: "unauthorized" });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    const reconnect = vi.fn();
    s.onReconnect(reconnect);
    await s.getToken();
    expect(clock.pending(), "a dead credential is not a bad connection").toBe(0);
    expect(s.ended()).toBe("unauthorized");
  });

  it("a knock already waiting is dropped when the session ends underneath it", async () => {
    // ⚠️ The ORDER is the case. "Refresh says the session is over" schedules nothing either way, so
    // asserting that alone leaves the guard unmeasured — measured: removing it kept every other case
    // green. The reachable sequence is retry FIRST, then the end, then the delay elapsing.
    const clock = fakeClock();
    refresh.mockResolvedValueOnce({ kind: "retry" })
      .mockResolvedValueOnce({ kind: "ended", why: "unauthorized" });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    const reconnect = vi.fn();
    s.onReconnect(reconnect);
    await s.getToken();                 // schedules
    await s.getToken();                 // ...and now the credential is dead
    expect(s.ended()).toBe("unauthorized");
    clock.fire();
    expect(reconnect, "a session that ended must not keep knocking").not.toHaveBeenCalled();
  });

  it("does not knock after the connection it would knock on is gone", async () => {
    const clock = fakeClock();
    refresh.mockResolvedValue({ kind: "retry" });
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    const reconnect = vi.fn();
    s.onReconnect(reconnect);
    await s.getToken();
    s.onReconnect(null); // the editor tore the provider down while the delay was running
    clock.fire();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("retries a throttled re-exchange at the twelve-hour boundary too", async () => {
    const clock = fakeClock();
    refresh.mockResolvedValue({ kind: "reenter" });
    exchange.mockResolvedValue("rate_limited");
    const s = makeGuestSession("L", minted(tokenExpiringIn(5)), undefined, clock.schedule);
    s.onReconnect(() => {});
    await s.getToken();
    expect(clock.pending(), "the ceiling plus a rate limit is still a guest who can come back").toBe(1);
    expect(s.ended()).toBeNull();
  });
});
