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
// Core: POST the plantuml source to a gated render endpoint and map the response to blob | null (degrade).
// The endpoint URL (page- vs template-scoped) is the only thing that varies; the request/response contract
// and the degrade rules are identical, so page and template previews cannot drift.
function makeRenderer(url: string, token: string, fetcher: Fetcher): DiagramRenderer {
  return async (lang, source, theme) => {
    if (lang !== "plantuml") return null; // only plantuml is host-rendered today
    if (!source.trim()) return null; // empty fence → nothing to render (the empty placeholder shows)
    try {
      const res = await fetcher(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // #342: forward the theme so a dark render gets a built-in `!theme` injected server-side. The
        // widget rebuilds on a theme switch (#200 — theme is in its eq() key), so this re-fetches for free.
        body: JSON.stringify({ source, theme }),
      });
      if (res.status !== 200) return null; // 204 = degrade-to-source; 4xx/5xx → keep the source too
      if (!(res.headers.get("content-type") ?? "").startsWith("image/")) return null; // raster only
      return await res.blob();
    } catch {
      return null; // network failure → degrade
    }
  };
}

export function makeDiagramRenderer(token: string, pageId: string, fetcher: Fetcher = fetch): DiagramRenderer {
  return makeRenderer(`${API_URL}/pages/${encodeURIComponent(pageId)}/plantuml/render`, token, fetcher);
}

// #376 / ADR-149 §2: the ANONYMOUS public reader's renderer — hits the abuse-bounded /public sibling
// (ANON view + published gate + source-membership + cache + rate limit server-side). No token. The
// same degrade rules: any refusal (400 non-member source, 404, 429, 204 unconfigured) keeps the fence.
export function makePublicDiagramRenderer(pageId: string, fetcher: Fetcher = fetch): DiagramRenderer {
  return makeRenderer(`${API_URL}/public/pages/${encodeURIComponent(pageId)}/plantuml/render`, "", fetcher);
}

// #267the TEMPLATE-preview variant — hits the template-scoped, view-gated render endpoint (a faithful
// mirror of the page one) so a template preview renders plantuml like the real editor. The server 404s a
// non-viewer (existence-hidden) and 204-degrades when the operator endpoint is unconfigured — same contract.
export function makeTemplateDiagramRenderer(token: string, templateId: string, fetcher: Fetcher = fetch): DiagramRenderer {
  return makeRenderer(`${API_URL}/templates/${encodeURIComponent(templateId)}/plantuml/render`, token, fetcher);
}
