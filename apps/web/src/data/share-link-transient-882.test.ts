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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchGuestToken, refreshGuestToken } from "./apiClient";

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

  // the body is a SECOND chance to fail and it was outside the try — the one path this ticket
  // is named after ("stuck on loading") was still reachable through it. A 200 whose stream is cut
  // after the headers is exactly what a pod being replaced mid-response produces.
  it("says 'not now' when a 200's body stops mid-stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new TypeError("network error"); },
    }));
    await expect(fetchGuestToken("L")).resolves.toBe("unavailable");
  });

  it("does the same on the renewal route, where the rejection would escape a non-throwing getter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new TypeError("network error"); },
    }));
    await expect(refreshGuestToken("L", "t")).resolves.toEqual({ kind: "retry" });
  });

  // second layer: the route's own `.then` had no catch, so anything the client did not turn
  // into a value left the page on its skeleton. Both entry paths carry one now.
  it("has a catch on both of the route's token calls", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../app/routes.tsx"), "utf8");
    const share = src.slice(src.indexOf("function ShareRoute("), src.indexOf("\nfunction ", src.indexOf("function ShareRoute(") + 1));
    expect(share.length, "ShareRoute's body is empty").toBeGreaterThan(200);
    const calls = share.match(/fetchGuestToken\(/g) ?? [];
    expect(calls.length, "both entry paths").toBe(2);
    expect((share.match(/\}\)\.catch\(/g) ?? []).length, "one catch per call").toBe(2);
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
