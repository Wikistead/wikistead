// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { printPageHtml } from "./exportApi";

// #207 part 2: printing routes through the #85 server HTML export (all macros static, no raw ::: leak)
// instead of window.print() on the virtualised editor surface. When the page has no exportable HTML
// (unpublished draft / unviewable → 404) printPageHtml must return false so the caller falls back to
// the live-surface print — verify that contract and that no offscreen frame is leaked into the DOM.
describe("printPageHtml (#207)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns false (fallback) when the page has no exportable HTML (404)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    const before = document.querySelectorAll("iframe").length;
    expect(await printPageHtml("tok", "page-1")).toBe(false);
    // the export.html route was hit with the bearer token (same auth as the download path)
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/pages/page-1/export.html");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    // no frame is appended on the failure path
    expect(document.querySelectorAll("iframe").length).toBe(before);
  });

  it("URL-encodes the page id in the export route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 404 }));
    await printPageHtml("tok", "a/b c");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/pages/a%2Fb%20c/export.html");
  });
});
