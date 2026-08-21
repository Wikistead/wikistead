// @vitest-environment happy-dom
//
// #813 / ADR-248 §3.5: the session that keeps a guest's credential alive without disturbing anything.
//
// The reported accident is the shape these cases drive: a token that lived five minutes, a socket
// refused while somebody was away, and a publish that said "published" over a draft none of it had
// reached. The renewal is the half that stops the credential dying; #873 is the half that stops the
// screen lying when it does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeGuestSession, needsRenewal, secondsLeft, RENEW_MARGIN_SECONDS } from "./guest-session";
import type { GuestToken } from "../data/apiClient";

/** A token shaped like the real one: three dots, plaintext claims in the middle. */
const tokenExpiringIn = (seconds: number, at = Date.now()): string => {
  const claims = btoa(JSON.stringify({ exp: Math.floor(at / 1000) + seconds, anonId: "anon:abc" }))
    .replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${claims}.signature`;
};
const minted = (token: string): GuestToken => ({ token, docName: "t:x:p:1", capability: "edit", readOnly: false });

describe("#813 how long is left", () => {
  it("is read from the token's own claim, not from a timer set at mint", () => {
    // A tab that slept through its own interval wakes up with the truth this way.
    expect(secondsLeft(tokenExpiringIn(300))).toBeGreaterThan(295);
    expect(secondsLeft(tokenExpiringIn(300))).toBeLessThanOrEqual(300);
    expect(secondsLeft(tokenExpiringIn(-10))).toBeLessThan(0);
  });

  it("⚠️ a token it cannot read is EXPIRED, never fresh", () => {
    // Erring the other way leaves a guest holding a credential nothing accepts, which is the defect.
    for (const bad of ["", "notatoken", "a.b", "a.!!!.c", `a.${btoa("{}")}.c`, `a.${btoa('{"exp":"soon"}')}.c`]) {
      expect(secondsLeft(bad), bad).toBe(0);
      expect(needsRenewal(bad), bad).toBe(true);
    }
  });

  it("renews before the last second, not on it", () => {
    // A token handed out with a second left expires between the getter returning it and the socket
    // presenting it.
    expect(needsRenewal(tokenExpiringIn(RENEW_MARGIN_SECONDS - 1))).toBe(true);
    expect(needsRenewal(tokenExpiringIn(RENEW_MARGIN_SECONDS + 30))).toBe(false);
  });
});

describe("#813 the session", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("hands out what it holds while the token is fresh, and asks nobody", async () => {
    const fresh = tokenExpiringIn(300);
    const s = makeGuestSession("link1", minted(fresh));
    expect(await s.getToken()).toBe(fresh);
    expect(fetchMock, "a fresh token must not cost a request").not.toHaveBeenCalled();
  });

  it("renews at connection time and both faces move together", async () => {
    const next = tokenExpiringIn(300);
    answer(200, minted(next));
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    expect(await s.getToken()).toBe(next);
    // ⚠️ The HTTP face reads the SAME holder. A renewal that moved only the socket's copy would leave
    // publish on a dead credential — which is the path the reported accident actually took.
    expect(s.current()).toBe(next);
  });

  it("⚠️ never throws, whatever the server says — a throwing getter latches reconnect off", async () => {
    // `permissionDeniedHandler` disconnects and stops the provider trying again, so a throw here costs
    // the session its own recovery.
    for (const [status, body] of [[429, {}], [401, { error: "unauthorized" }], [404, {}], [500, {}]] as const) {
      fetchMock.mockReset();
      answer(status, body);
      const held = tokenExpiringIn(5);
      const s = makeGuestSession("link1", minted(held));
      await expect(s.getToken()).resolves.toBe(held);
    }
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const held = tokenExpiringIn(5);
    await expect(makeGuestSession("link1", minted(held)).getToken()).resolves.toBe(held);
  });

  it("a rate limit is not an ending — it keeps what it holds and asks again next time", async () => {
    answer(429, {});
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    await s.getToken();
    expect(s.ended(), "429 is a bucket, not a verdict about the session").toBe(null);
    const next = tokenExpiringIn(300);
    answer(200, minted(next));
    expect(await s.getToken()).toBe(next);
  });

  it("a dead credential ends the session, and it stops asking", async () => {
    answer(401, { error: "unauthorized" });
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    await s.getToken();
    expect(s.ended()).toBe("unauthorized");
    const calls = fetchMock.mock.calls.length;
    await s.getToken();
    expect(fetchMock.mock.calls.length, "an ended session must not keep knocking").toBe(calls);
  });

  it("a revoked link ends it too, and is told apart from a dead token", async () => {
    answer(404, {});
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    await s.getToken();
    expect(s.ended()).toBe("gone");
  });

  it("⚠️ at the twelve-hour ceiling it enters again, carrying the pseudonym", async () => {
    // The ceiling refuses the refresh with `session_ended`, and exchanging again WHILE STILL HOLDING a
    // live token is what carries `anonId` across the boundary. A fresh pseudonym would split twelve
    // hours of one person's work between two names — and rollback-by-actor would reach half of it.
    answer(401, { error: "session_ended" });
    const after = tokenExpiringIn(300);
    answer(200, minted(after));
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    expect(await s.getToken()).toBe(after);
    expect(s.ended()).toBe(null);
    const [refreshUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [exchangeUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(refreshUrl).toContain("/token/refresh");
    expect(exchangeUrl, "the boundary re-entry is the exchange, not the refresh").not.toContain("/refresh");
  });

  it("and if that door now asks for a password, the session is over rather than silently stuck", async () => {
    answer(401, { error: "session_ended" });
    answer(401, {}); // the exchange answers password_required
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    await s.getToken();
    expect(s.ended()).toBe("unauthorized");
  });

  it("⚠️ two connections opening together renew once, not twice", async () => {
    // The page's room and a macro's ephemeral room open at the same moment. Two renewals would mean
    // the second replaces a token the first had already handed to a socket.
    const next = tokenExpiringIn(300);
    answer(200, minted(next));
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)));
    const [a, b] = await Promise.all([s.getToken(), s.getToken()]);
    expect(a).toBe(next);
    expect(b).toBe(next);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("tells the host when the capability changed, and never hands it the token", async () => {
    const seen: GuestToken[] = [];
    const narrowed: GuestToken = { token: tokenExpiringIn(300), docName: "t:x:p:1", capability: "view", readOnly: true };
    answer(200, narrowed);
    const s = makeGuestSession("link1", minted(tokenExpiringIn(5)), (m) => seen.push(m));
    await s.getToken();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.capability).toBe("view");
  });
});
