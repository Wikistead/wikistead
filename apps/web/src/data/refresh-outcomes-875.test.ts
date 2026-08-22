// @vitest-environment happy-dom
//
// #875 (review rejection): which answers end a guest's session, and which are just a bad moment.
//
// ADR-248 §3.6 names two terminal statuses: 401 (the credential is dead) and 404 (the link is). The
// mapping fell through to "ended" for EVERYTHING else, so a 502 from a rolling restart, a gateway
// timeout, or the 404 an old pod answers while it drains all read to the guest as "this link is no
// longer valid" — permanently, with no way back short of a reload. A redeploy looked like a revocation.
//
// The cases below drive the real function against injected responses; the terminal and non-terminal
// halves are BOTH asserted, because a mapping that ends nothing satisfies the second half alone.
import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshGuestToken } from "./apiClient";

const respond = (status: number, body: unknown = {}) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("#875 a deployment having a moment is not a revoked link", () => {
  it.each([500, 502, 503, 504, 408, 425])("keeps the session alive on %i", async (status) => {
    respond(status);
    expect(await refreshGuestToken("L", "t")).toEqual({ kind: "retry" });
  });

  it("keeps the session alive when the request never arrived at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect(await refreshGuestToken("L", "t")).toEqual({ kind: "retry" });
  });

  it("still ends on the two answers that mean it is over", async () => {
    respond(404);
    expect(await refreshGuestToken("L", "t"), "the link itself is gone").toEqual({ kind: "ended", why: "gone" });
    respond(401, { error: "unauthorized" });
    expect(await refreshGuestToken("L", "t"), "the credential is dead").toEqual({ kind: "ended", why: "unauthorized" });
  });

  it("tells the twelve-hour ceiling apart from a dead credential", async () => {
    respond(401, { error: "session_ended" });
    expect(await refreshGuestToken("L", "t")).toEqual({ kind: "reenter" });
  });

  it("a rate limit was already a retry, and stays one", async () => {
    respond(429);
    expect(await refreshGuestToken("L", "t")).toEqual({ kind: "retry" });
  });

  it("a renewal is adopted", async () => {
    const tok = { token: "a.b.c", docName: "t:x:p:1", capability: "edit", readOnly: false };
    respond(200, tok);
    expect(await refreshGuestToken("L", "t")).toEqual({ kind: "renewed", minted: tok });
  });
});
