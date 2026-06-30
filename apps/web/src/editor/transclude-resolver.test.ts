// Host-mediated transclude resolver (#108 / ADR-071). The macro never fetches; this is the host
// side. Verified with an injected fetcher: 200 → the referenced content; every existence-hiding /
// failure path (403 denied, 422 cycle|depth, empty ref, missing content, network error) → null so
// the widget shows the same placeholder (a viewer can't distinguish "denied" from "absent").
import { describe, it, expect } from "vitest";
import { makeTranscludeResolver } from "./transclude-resolver";

function stub(res: Response | (() => Promise<never>)) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (typeof res === "function") return res();
    return res;
  };
  return { fetcher, calls };
}

describe("makeTranscludeResolver (#108 / ADR-071)", () => {
  it("returns the referenced page content on 200, hitting the host-scoped route with the ref id", async () => {
    const { fetcher, calls } = stub(new Response(JSON.stringify({ content: "# Hello" }), { status: 200 }));
    const out = await makeTranscludeResolver("tok", "host-1", fetcher)("ref-2");
    expect(out).toBe("# Hello");
    expect(calls[0]).toMatch(/\/pages\/host-1\/transclude\/ref-2$/);
  });

  it("returns null for 403 (denied) and 422 (cycle/depth) — same placeholder, no existence oracle", async () => {
    expect(await makeTranscludeResolver("t", "h", stub(new Response("{}", { status: 403 })).fetcher)("r")).toBeNull();
    expect(await makeTranscludeResolver("t", "h", stub(new Response("{}", { status: 422 })).fetcher)("r")).toBeNull();
  });

  it("returns null for an empty ref WITHOUT fetching", async () => {
    const { fetcher, calls } = stub(new Response(JSON.stringify({ content: "x" }), { status: 200 }));
    expect(await makeTranscludeResolver("t", "h", fetcher)("   ")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when 200 but the body has no content string, and on a network error", async () => {
    expect(await makeTranscludeResolver("t", "h", stub(new Response("{}", { status: 200 })).fetcher)("r")).toBeNull();
    expect(await makeTranscludeResolver("t", "h", stub(() => Promise.reject(new Error("offline"))).fetcher)("r")).toBeNull();
  });
});
