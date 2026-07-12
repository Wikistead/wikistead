// Host-mediated diagram render client (#140 / ADR-074). The macro never fetches; this is the host
// side. Verified with an injected fetcher (no network): only plantuml is rendered, the gated
// page-scoped endpoint is called with the source, 200 image → Blob, and every degrade path
// (non-plantuml, empty, 204, non-200, non-image, network error) returns null so the widget keeps
// the source fence.
import { describe, it, expect } from "vitest";
import { makeDiagramRenderer, makeTemplateDiagramRenderer } from "./diagram-renderer";

function stub(res: Response | (() => Promise<never>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof res === "function") return res();
    return res;
  };
  return { fetcher, calls };
}
const png = (bytes = 3) => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });

describe("makeDiagramRenderer (#140 / ADR-074)", () => {
  it("renders plantuml: POSTs the source to the page-scoped endpoint and returns the image Blob", async () => {
    const { fetcher, calls } = stub(png(4));
    const render = makeDiagramRenderer("tok", "page-1", fetcher);
    const blob = await render("plantuml", "@startuml\nA->B\n@enduml");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.size).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/pages\/page-1\/plantuml\/render$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ source: "@startuml\nA->B\n@enduml" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("degrades (null) for a non-host-rendered lang and an empty body WITHOUT fetching", async () => {
    const { fetcher, calls } = stub(png());
    const render = makeDiagramRenderer("tok", "page-1", fetcher);
    expect(await render("mermaid", "graph TD;A-->B")).toBeNull();
    expect(await render("plantuml", "   \n  ")).toBeNull();
    expect(calls).toHaveLength(0); // neither reaches the network
  });

  it("degrades on 204 (operator endpoint unconfigured/failed)", async () => {
    const { fetcher } = stub(new Response(null, { status: 204 }));
    expect(await makeDiagramRenderer("tok", "p", fetcher)("plantuml", "x")).toBeNull();
  });

  it("degrades on a non-200 status and on a non-image 200 body", async () => {
    expect(await makeDiagramRenderer("t", "p", stub(new Response("err", { status: 500 })).fetcher)("plantuml", "x")).toBeNull();
    const html = new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await makeDiagramRenderer("t", "p", stub(html).fetcher)("plantuml", "x")).toBeNull();
  });

  it("degrades on a network error (never throws — the widget keeps the source)", async () => {
    const { fetcher } = stub(() => Promise.reject(new Error("offline")));
    await expect(makeDiagramRenderer("t", "p", fetcher)("plantuml", "x")).resolves.toBeNull();
  });
});

// #267 the template-preview variant hits the TEMPLATE-scoped endpoint instead of the page one; the
// request/response contract (POST source, 200 image → Blob, 204/non-200/non-image → null) is identical.
describe("makeTemplateDiagramRenderer (#267)", () => {
  it("POSTs the source to the template-scoped endpoint and returns the image Blob", async () => {
    const { fetcher, calls } = stub(png(5));
    const blob = await makeTemplateDiagramRenderer("tok", "tpl-9", fetcher)("plantuml", "@startuml\nA->B\n@enduml");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.size).toBe(5);
    expect(calls[0].url).toMatch(/\/templates\/tpl-9\/plantuml\/render$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("shares the degrade rules (204 / non-plantuml / empty → null)", async () => {
    expect(await makeTemplateDiagramRenderer("t", "tpl", stub(new Response(null, { status: 204 })).fetcher)("plantuml", "x")).toBeNull();
    const { fetcher, calls } = stub(png());
    expect(await makeTemplateDiagramRenderer("t", "tpl", fetcher)("mermaid", "graph")).toBeNull();
    expect(await makeTemplateDiagramRenderer("t", "tpl", fetcher)("plantuml", "  ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
