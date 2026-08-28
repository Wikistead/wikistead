import type { Bearer } from "../data/apiClient";

const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "/api";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type EmbedFrameabilityChecker = (url: string) => Promise<"embeddable" | "refused">;

// #970 / ADR-267 §3.1: host-side resolver behind the async embed frameability probe. The MACRO never
// fetches (host-API is {theme} only, ADR-024); this asks the gated GET /pages/:id/embed/frameability,
// which re-runs the page-view gate + tenant allowlist server-side (never trust this client-side
// allowlist check alone) before probing headers. ANY failure — non-200, network error, malformed body
// — degrades to "embeddable" (§3.3's fail-open: a missed refusal is the shipped-today shape; a false
// refusal replaces a working embed with a sentence, #207's content-loss).
export function makeEmbedFrameabilityChecker(bearer: Bearer, hostPageId: string, fetcher: Fetcher = fetch): EmbedFrameabilityChecker {
  return async (url) => {
    try {
      const token = typeof bearer === "function" ? bearer() : bearer;
      const res = await fetcher(
        `${API_URL}/pages/${encodeURIComponent(hostPageId)}/embed/frameability?url=${encodeURIComponent(url)}`,
        { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (res.status !== 200) return "embeddable"; // degrade — never a false refusal
      const data = (await res.json()) as { verdict?: unknown };
      return data.verdict === "refused" ? "refused" : "embeddable";
    } catch {
      return "embeddable"; // network failure → degrade
    }
  };
}
