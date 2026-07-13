import { describe, it, expect } from "vitest";
import { makeLinkStatusResolver } from "./link-status";

// #276 / ADR-117: the client resolver behind the dead-internal-link overlay. It POSTs the collected ids
// to the gated /pages/link-status and returns the viewable subset; anything absent is dead. Every failure
// path degrades to null so the overlay leaves links ALIVE (never a false "dead"). Injected fetcher — no net.
function stub(res: Response | (() => Promise<never>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof res === "function") return res();
    return res;
  };
  return { fetcher, calls };
}
const ok = (viewable: unknown) => new Response(JSON.stringify({ viewable }), { status: 200, headers: { "content-type": "application/json" } });

describe("makeLinkStatusResolver (#276 / ADR-117)", () => {
  it("POSTs the ids to the gated endpoint and returns the viewable subset as a Set", async () => {
    const { fetcher, calls } = stub(ok(["a", "c"]));
    const set = await makeLinkStatusResolver("tok", fetcher)(["a", "b", "c"]);
    expect(set).toEqual(new Set(["a", "c"]));
    expect(calls[0].url).toMatch(/\/pages\/link-status$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ids: ["a", "b", "c"] });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("resolves an empty Set for an empty id list WITHOUT fetching", async () => {
    const { fetcher, calls } = stub(ok([]));
    expect(await makeLinkStatusResolver("tok", fetcher)([])).toEqual(new Set());
    expect(calls).toHaveLength(0);
  });

  it("degrades to null (leave links alive) on a non-200, a malformed body, and a network error", async () => {
    expect(await makeLinkStatusResolver("t", stub(new Response("err", { status: 500 })).fetcher)(["a"])).toBeNull();
    const bad = new Response(JSON.stringify({ nope: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await makeLinkStatusResolver("t", stub(bad).fetcher)(["a"])).toBeNull();
    expect(await makeLinkStatusResolver("t", stub(() => Promise.reject(new Error("offline"))).fetcher)(["a"])).toBeNull();
  });

  it("filters non-string entries from a (defensive) malformed viewable array", async () => {
    const set = await makeLinkStatusResolver("t", stub(ok(["a", 5, null, "b"])).fetcher)(["a", "b"]);
    expect(set).toEqual(new Set(["a", "b"]));
  });
});
