// @vitest-environment happy-dom
//
// #813 (review rejection): the exchange carries the pseudonym only when there is one to carry.
//
// THE DEFECT: `fetchGuestToken` sent no `Authorization` at all, and the server takes the continuation
// from that header and nowhere else (`share-links.ts` verifies the presented token and carries
// `anonId` only when the link and the tenant match). So the twelve-hour re-exchange always minted a
// FRESH pseudonym: the pages that visitor created stayed behind under the old name, every edit they
// had made kept the old actor, and rollback-by-actor no longer reached their work.
//
// ⚠️ BOTH DIRECTIONS, because they fail differently. Sending it always is not a smaller bug: a first
// exchange holds nothing, so the header would be `Bearer undefined` for the server to reject.
//
// The assertions read the RequestInit the shipping client BUILT. The previous pin ran the same code
// and asserted only the URL — the pseudonym is not in the URL, so it named the guarantee and measured
// none of it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchGuestToken } from "./apiClient";

const capture = () => {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: "x" }) });
  vi.stubGlobal("fetch", f);
  return f;
};
const authOf = (f: ReturnType<typeof capture>) =>
  new Headers((f.mock.calls[0]![1] as RequestInit).headers as HeadersInit).get("authorization");

afterEach(() => { vi.unstubAllGlobals(); });

describe("#813 the exchange and the token in hand", () => {
  it("sends the token it was given, so the server can continue the same person", async () => {
    const f = capture();
    await fetchGuestToken("L", undefined, "still.alive.token");
    expect(authOf(f)).toBe("Bearer still.alive.token");
  });

  it("sends nothing on a first exchange — there is no one to continue", async () => {
    const f = capture();
    await fetchGuestToken("L");
    expect(authOf(f), "a visitor arriving for the first time holds no credential").toBeNull();
  });

  it("a password link with no token in hand still sends no bearer", async () => {
    const f = capture();
    await fetchGuestToken("L", "hunter2");
    expect(authOf(f)).toBeNull();
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers as HeadersInit).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ password: "hunter2" }));
  });

  it("carries both when a password link is re-entered at the ceiling", async () => {
    const f = capture();
    await fetchGuestToken("L", "hunter2", "still.alive.token");
    const init = f.mock.calls[0]![1] as RequestInit;
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer still.alive.token");
    expect(h.get("content-type"), "the password still has to arrive as JSON").toBe("application/json");
  });
});
