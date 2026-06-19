// Thin authenticated fetch wrapper for the chrome (sidebar/tree/search/etc.).
// The tenant is resolved server-side from the request Host (dev: localhost ->
// tenant_dev), so callers only supply the bearer token. Screens in the next
// stage build their queries on top of this (the data-fetching library is
// deferred until the first screen's requirements are known — ADR-013).
// Same-origin by default (ADR-016): "/api" is proxied to the API, so the BFF
// session cookie is sent. Absolute URLs are still honored if explicitly set.
const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include", // send the BFF session cookie (same-origin)
    headers: {
      // Only declare a JSON body when there actually is one — a body-less POST
      // (e.g. /attachments/:id/confirm) with content-type: application/json is
      // rejected by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY).
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      // Bearer is for dev-token / programmatic callers; browser members rely on
      // the cookie. Omit the header when there is no token.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, path, `API ${res.status} for ${path}`);
  }
  return res.status === 204 ? null : ((await res.json()) as T);
}

export interface GuestToken {
  token: string;
  docName: string;
  capability: "view" | "edit";
  readOnly: boolean;
}

// Guest landing: exchange a share-link id for a short-lived guest token. No auth
// (the link id is the capability). Any failure -> null (server answers a uniform
// 404 for missing/revoked/expired so we cannot distinguish — by design).
export async function fetchGuestToken(linkId: string): Promise<GuestToken | null> {
  const res = await fetch(`${API_URL}/public/share-links/${encodeURIComponent(linkId)}/token`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return null;
  return (await res.json()) as GuestToken;
}
