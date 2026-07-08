import type { TranscludeResolver } from "./live-preview/decorations";

const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Host-mediated internal transclude (#108 / ADR-071). The MACRO never fetches — its host-API is
// {theme} only (ADR-024); this host-side resolver calls the gated server route, which re-checks
// `view` on the REFERENCED page itself (not just the host page) and hides existence uniformly. It
// returns the referenced page's published markdown, or null to render an existence-hiding
// placeholder (denied / cycle / depth / absent / network error — all indistinguishable to the UI,
// so a viewer can't probe for pages they can't see). hostPageId scopes the request's page-view gate.
export function makeTranscludeResolver(token: string, hostPageId: string, fetcher: Fetcher = fetch): TranscludeResolver {
  return async (refId) => {
    const ref = refId.trim();
    if (!ref) return null;
    try {
      const res = await fetcher(
        `${API_URL}/pages/${encodeURIComponent(hostPageId)}/transclude/${encodeURIComponent(ref)}`,
        { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (res.status !== 200) return null; // 404 denied (#280 existence-hiding) / 422 cycle|depth → placeholder
      const body = (await res.json()) as { content?: string };
      return typeof body.content === "string" ? body.content : null;
    } catch {
      return null; // network failure → placeholder
    }
  };
}
