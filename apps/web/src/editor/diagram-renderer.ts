import type { DiagramRenderer } from "./live-preview/decorations";

const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Host-mediated diagram render (#140 / ADR-074). The MACRO never fetches — its host-API is {theme}
// only (ADR-024 trust boundary); this host-side renderer is what actually POSTs the fence source to
// the page's gated render endpoint (page-view authz enforced server-side) and returns the image
// bytes. It returns null to DEGRADE — the widget then keeps showing the source fence (Open formats;
// never a broken embed). null on: a non-host-rendered lang, an empty body, 204 (operator endpoint
// unconfigured / failed), any non-200, a non-image body, or a network error. The fetcher is
// injectable so the request/response mapping is unit-tested without a real network.
export function makeDiagramRenderer(token: string, pageId: string, fetcher: Fetcher = fetch): DiagramRenderer {
  return async (lang, source) => {
    if (lang !== "plantuml") return null; // only plantuml is host-rendered today
    if (!source.trim()) return null; // empty fence → nothing to render (the empty placeholder shows)
    try {
      const res = await fetcher(`${API_URL}/pages/${encodeURIComponent(pageId)}/plantuml/render`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ source }),
      });
      if (res.status !== 200) return null; // 204 = degrade-to-source; 4xx/5xx → keep the source too
      if (!(res.headers.get("content-type") ?? "").startsWith("image/")) return null; // raster only
      return await res.blob();
    } catch {
      return null; // network failure → degrade
    }
  };
}
