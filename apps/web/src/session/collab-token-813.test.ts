// @vitest-environment happy-dom
//
// #813 / ADR-248 §3.10: the member's collaboration credential renews, and does so without becoming a
// React value. The defect it replaces: one fetch at bootstrap, a 300-second token, and a member who
// reconnected six minutes later authenticating with a corpse — then, by the detach in §3.6, receiving
// nothing further in silence with publish and the checkbox withheld until a reload.
import { describe, it, expect, vi } from "vitest";
import { makeCollabTokenSource } from "./collab-token";

const expiringIn = (seconds: number): string => {
  const claims = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))
    .replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${claims}.signature`;
};

describe("#813 the member's collab credential", () => {
  it("mints again when the one it holds is about to die", async () => {
    const fresh = expiringIn(600);
    const mint = vi.fn().mockResolvedValue(fresh);
    const s = makeCollabTokenSource(mint);
    s.set(expiringIn(10));
    expect(await s.get()).toBe(fresh);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("does not spend a round trip on a healthy one", async () => {
    // The renewal is lazy, at connection time: an idle tab that never reconnects costs the server
    // nothing, and the tab that does reconnect gets a token minted for that moment.
    const mint = vi.fn().mockResolvedValue(expiringIn(600));
    const s = makeCollabTokenSource(mint);
    s.set(expiringIn(600));
    expect(await s.get()).toBe(await s.get());
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints ONCE when two connections open together", async () => {
    // The page and a macro's ephemeral room open at the same moment. Two mints would mean the second
    // replaces a token the first had already handed to a socket.
    let release: (t: string) => void = () => {};
    const mint = vi.fn().mockReturnValue(new Promise<string>((r) => { release = r; }));
    const s = makeCollabTokenSource(mint);
    s.set(expiringIn(10));
    const both = Promise.all([s.get(), s.get()]);
    release(expiringIn(600));
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("keeps what it holds when the mint fails, and never throws", async () => {
    // A getter that throws reaches permissionDeniedHandler, which disconnects and latches
    // reconnection off; one that returns "" asks the server to refuse an empty credential for no
    // reason. Let the server refuse the token we have, and let #875's retry knock again.
    const dying = expiringIn(10);
    for (const mint of [vi.fn().mockRejectedValue(new Error("down")), vi.fn().mockResolvedValue(null)]) {
      const s = makeCollabTokenSource(mint);
      s.set(dying);
      await expect(s.get()).resolves.toBe(dying);
    }
  });

  it("leaves a dev-token session alone — that credential IS the session", async () => {
    const dev = "dev-token-value";
    const mint = vi.fn();
    const s = makeCollabTokenSource(mint, dev);
    expect(await s.get()).toBe(dev);
    expect(mint, "there is no route to ask and nothing to renew").not.toHaveBeenCalled();
  });

  it("forgets the credential on sign-out", async () => {
    const next = expiringIn(600);
    const mint = vi.fn().mockResolvedValue(next);
    const s = makeCollabTokenSource(mint);
    s.set(expiringIn(600));
    s.clear();
    // A socket opened after a sign-out must not present the token of the person who just left.
    expect(await s.get()).toBe(next);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("hands out the same function forever — a changing one rebuilds the socket and the Y.Doc", () => {
    const s = makeCollabTokenSource(vi.fn());
    expect(s.get).toBe(s.get);
  });
});
