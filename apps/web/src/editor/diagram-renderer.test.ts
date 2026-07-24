// Host-mediated diagram render client (#140 / ADR-074). The macro never fetches; this is the host
// side. Verified with an injected fetcher (no network): only plantuml is rendered, the gated
// page-scoped endpoint is called with the source, and each server outcome maps to the verdict the
// widget needs — #525 200 image → the blob, 204 → a silent degrade (the operator has not
// configured a renderer), 422 → the DIAGRAM is invalid (a visible error, mermaid parity), 503 /
// network → the renderer is unavailable (an outage, never reported as a syntax error).
import { describe, it, expect } from "vitest";
import { makeDiagramRenderer, makeTemplateDiagramRenderer } from "./diagram-renderer";
import type { DiagramRenderResult } from "./live-preview/decorations";

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
const blobOf = (r: DiagramRenderResult): Blob | null =>
  r instanceof Blob ? r : r && typeof r === "object" && "ok" in r && r.ok ? r.blob : null;
const reasonOf = (r: DiagramRenderResult): string | null =>
  r && typeof r === "object" && "ok" in r && !r.ok ? r.reason : null;

describe("makeDiagramRenderer (#140 / ADR-074)", () => {
  it("renders plantuml: POSTs the source to the page-scoped endpoint and returns the image Blob", async () => {
    const { fetcher, calls } = stub(png(4));
    const render = makeDiagramRenderer("tok", "page-1", fetcher);
    const res = await render("plantuml", "@startuml\nA->B\n@enduml");
    const blob = blobOf(res);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.size).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/pages\/page-1\/plantuml\/render$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ source: "@startuml\nA->B\n@enduml" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("#342: forwards the theme to the endpoint so a dark render is themed server-side", async () => {
    const { fetcher, calls } = stub(png(4));
    const render = makeDiagramRenderer("tok", "page-1", fetcher);
    await render("plantuml", "@startuml\nA->B\n@enduml", "dark");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ source: "@startuml\nA->B\n@enduml", theme: "dark" });
  });

  it("degrades for a non-host-rendered lang and an empty body WITHOUT fetching", async () => {
    const { fetcher, calls } = stub(png());
    const render = makeDiagramRenderer("tok", "page-1", fetcher);
    expect(await render("mermaid", "graph TD;A-->B")).toBeNull();
    expect(await render("plantuml", "   \n  ")).toBeNull();
    expect(calls).toHaveLength(0); // neither reaches the network
  });

  it("204 (operator endpoint unconfigured) is a SILENT degrade — not an error the author can act on", async () => {
    const { fetcher } = stub(new Response(null, { status: 204 }));
    expect(reasonOf(await makeDiagramRenderer("tok", "p", fetcher)("plantuml", "x"))).toBe("degrade");
  });

  it("#525 422 says the DIAGRAM is invalid (so the widget can show it, like mermaid)", async () => {
    const r = new Response(JSON.stringify({ reason: "invalid_diagram" }), { status: 422, headers: { "content-type": "application/json" } });
    expect(reasonOf(await makeDiagramRenderer("t", "p", stub(r).fetcher)("plantuml", "@startuml\nnope"))).toBe("invalid");
  });

  it("#525 503 and a network error are an OUTAGE, kept distinct from a syntax error", async () => {
    const five = new Response(JSON.stringify({ reason: "renderer_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    expect(reasonOf(await makeDiagramRenderer("t", "p", stub(five).fetcher)("plantuml", "x"))).toBe("unavailable");
    const { fetcher } = stub(() => Promise.reject(new Error("offline")));
    expect(reasonOf(await makeDiagramRenderer("t", "p", fetcher)("plantuml", "x"))).toBe("unavailable");
  });

  it("other refusals (access / abuse answers) and a non-image body stay a plain degrade", async () => {
    expect(reasonOf(await makeDiagramRenderer("t", "p", stub(new Response("no", { status: 404 })).fetcher)("plantuml", "x"))).toBe("degrade");
    expect(reasonOf(await makeDiagramRenderer("t", "p", stub(new Response("slow", { status: 429 })).fetcher)("plantuml", "x"))).toBe("degrade");
    const html = new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(reasonOf(await makeDiagramRenderer("t", "p", stub(html).fetcher)("plantuml", "x"))).toBe("degrade");
  });
});

// #267 the template-preview variant hits the TEMPLATE-scoped endpoint instead of the page one; the
// request/response contract is identical, so page and template previews cannot drift.
describe("makeTemplateDiagramRenderer (#267)", () => {
  it("POSTs the source to the template-scoped endpoint and returns the image Blob", async () => {
    const { fetcher, calls } = stub(png(5));
    const res = await makeTemplateDiagramRenderer("tok", "tpl-9", fetcher)("plantuml", "@startuml\nA->B\n@enduml");
    const blob = blobOf(res);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.size).toBe(5);
    expect(calls[0].url).toMatch(/\/templates\/tpl-9\/plantuml\/render$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("shares the verdict rules (204 degrade / non-plantuml / empty; 422 invalid)", async () => {
    expect(reasonOf(await makeTemplateDiagramRenderer("t", "tpl", stub(new Response(null, { status: 204 })).fetcher)("plantuml", "x"))).toBe("degrade");
    expect(reasonOf(await makeTemplateDiagramRenderer("t", "tpl", stub(new Response("bad", { status: 422 })).fetcher)("plantuml", "x"))).toBe("invalid");
    const { fetcher, calls } = stub(png());
    expect(await makeTemplateDiagramRenderer("t", "tpl", fetcher)("mermaid", "graph")).toBeNull();
    expect(await makeTemplateDiagramRenderer("t", "tpl", fetcher)("plantuml", "  ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
