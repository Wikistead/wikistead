// @vitest-environment happy-dom
//
// #882: opening a share link while the deployment is having a moment.
//
// TWO defects, and they fail differently, so they are measured apart:
//
//   ① every non-OK status became `null`, and the caller renders `null` as "this share link is
//      invalid, expired, or revoked". A 502 from a rolling restart therefore told somebody holding a
//      perfectly good address that the person who sent it got it wrong.
//   ② `fetch` REJECTS when the request never arrives and there was no catch here — so a flaky
//      connection produced an unhandled rejection, neither branch of the caller ran, and the page sat
//      on its loading skeleton with no way out but a reload.
//
// ⚠️ AND THE OVER-CORRECTION. Treating everything as transient is not a smaller bug: a link that
// really was revoked would then say "try again in a moment" forever. 404 is the link answering for
// itself and stays terminal, which is the line ADR-248 §3.6 already draws for the refresh route.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchGuestToken } from "./apiClient";

const respond = (status: number, body: unknown = {}) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("#882 a deployment having a moment is not a revoked link", () => {
  it.each([500, 502, 503, 504, 408, 425])("says 'not now' on %i, not 'this link is dead'", async (status) => {
    respond(status);
    expect(await fetchGuestToken("L")).toBe("unavailable");
  });

  it("says 'not now' when the request never arrived, instead of never resolving", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    // The assertion IS that this resolves. Before, the promise rejected and the caller — which has no
    // catch — left the page on its skeleton.
    await expect(fetchGuestToken("L")).resolves.toBe("unavailable");
  });

  it("still calls a revoked link revoked", async () => {
    respond(404);
    expect(await fetchGuestToken("L"), "404 is the link answering for itself").toBeNull();
  });

  it("leaves the two answers that were already right alone", async () => {
    respond(401);
    expect(await fetchGuestToken("L")).toBe("password_required");
    respond(429);
    expect(await fetchGuestToken("L")).toBe("rate_limited");
  });

  it("mints when the server mints", async () => {
    const tok = { token: "a.b.c", docName: "t:x:p:1", capability: "edit", readOnly: false };
    respond(200, tok);
    expect(await fetchGuestToken("L")).toEqual(tok);
  });
});
