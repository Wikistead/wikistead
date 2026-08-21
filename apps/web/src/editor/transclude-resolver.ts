import type { TranscludeResolver } from "./live-preview/decorations";
import { type Bearer, bearerValue } from "../data/apiClient";

const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Host-mediated internal transclude (#108 / ADR-071). The MACRO never fetches — its host-API is
// {theme} only (ADR-024); this host-side resolver calls the gated server route, which re-checks
// `view` on the REFERENCED page itself (not just the host page) and hides existence uniformly. It
// returns the referenced page's published markdown, or null to render an existence-hiding
// placeholder (denied / cycle / depth / absent / network error — all indistinguishable to the UI,
// so a viewer can't probe for pages they can't see). hostPageId scopes the request's page-view gate.
export function makeTranscludeResolver(token: Bearer, hostPageId: string, fetcher: Fetcher = fetch): TranscludeResolver {
  return makeResolver(`${API_URL}/pages/${encodeURIComponent(hostPageId)}/transclude`, token, fetcher);
}

// #376 / ADR-149 §2: the ANONYMOUS public reader's resolver — the /public sibling gates the HOST page
// (ANON view + published + tenant switch) and re-gates the REF page as user:anonymous inside (uniform
// 'denied' → 404: unviewable ≡ unpublished ≡ absent — the existence-hiding placeholder here).
export function makePublicTranscludeResolver(hostPageId: string, fetcher: Fetcher = fetch): TranscludeResolver {
  return makeResolver(`${API_URL}/public/pages/${encodeURIComponent(hostPageId)}/transclude`, "", fetcher);
}

function makeResolver(baseUrl: string, token: Bearer, fetcher: Fetcher): TranscludeResolver {
  return async (refId) => {
    const ref = refId.trim();
    if (!ref) return null;
    try {
      const res = await fetcher(
        `${baseUrl}/${encodeURIComponent(ref)}`,
        { credentials: "include", headers: (() => { const t = bearerValue(token); return (t ? { Authorization: `Bearer ${t}` } : {}) as Record<string, string>; })() },
      );
      if (res.status !== 200) return null; // 404 denied (#280 existence-hiding) / 422 cycle|depth → placeholder
      const body = (await res.json()) as { content?: string };
      return typeof body.content === "string" ? body.content : null;
    } catch {
      return null; // network failure → placeholder
    }
  };
}
