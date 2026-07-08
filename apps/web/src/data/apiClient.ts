// Thin authenticated fetch wrapper for the chrome (sidebar/tree/search/etc.).
// The tenant is resolved server-side from the request Host (dev: localhost ->
// tenant_dev), so callers only supply the bearer token. Screens in the next
// stage build their queries on top of this (the data-fetching library is
// deferred until the first screen's requirements are known — ADR-013).
// Same-origin by default (ADR-016): "/api" is proxied to the API, so the BFF
// session cookie is sent. Absolute URLs are still honored if explicitly set.
const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

// Absolute URL for a server-served asset path (e.g. a public space icon), for use as
// an <img> src. The API is reachable only under the API base — a bare path would hit
// the SPA origin and resolve to index.html — so asset paths must be prefixed too.
export const assetUrl = (path: string) => `${API_URL}${path}`;

export class ApiError extends Error {
  // `code` / `upgrade` come from the server error body (entitlement-ux.ts): an entitlement gate
  // returns 403 + `<feature>_not_entitled` (or `upgrade_required`); the client uses these to
  // distinguish an entitlement loss (offer "upgrade", data preserved) from an authz loss (404,
  // existence-hiding, NEVER an affordance — see disclosureKindFromError in ui/upgrade-affordance).
  code?: string;
  upgrade?: boolean;
  constructor(public status: number, public path: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// Build an ApiError from a status + parsed error body. Pure (no fetch) so the body→error mapping is
// unit-tested directly. The body is whatever the server sent (Fastify's default shape is
// { statusCode, code, error, message }); `upgrade` is honored if present. Defensive against a
// non-object / non-JSON body (e.g. an HTML error page) — falls back to a generic message.
export function apiErrorFrom(status: number, path: string, body: unknown): ApiError {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof b.message === "string" && b.message ? b.message : `API ${status} for ${path}`;
  const err = new ApiError(status, path, message);
  if (typeof b.code === "string") err.code = b.code;
  if (b.upgrade === true) err.upgrade = true;
  return err;
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
    // Capture the error body so entitlement denials (code / upgrade) survive to the UI. A body that
    // isn't JSON (HTML error page, empty) just yields a generic ApiError.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body — keep body null */
    }
    throw apiErrorFrom(res.status, path, body);
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
// #233 / ADR-107: a 4-way result. A GuestToken on success; "password_required" for a LIVE password link
// with no/wrong password (HTTP 401 — the caller shows a password prompt); "rate_limited" when the
// wrong-password throttle has tripped (HTTP 429 — the caller keeps the prompt but shows a cool-down
// message instead of dropping to the dead-link view, #233); null for a dead link (404) or any
// other failure (uniform — no existence/password oracle). `password` re-POSTs the mint with the entry.
export type GuestTokenResult = GuestToken | "password_required" | "rate_limited" | null;
export async function fetchGuestToken(linkId: string, password?: string): Promise<GuestTokenResult> {
  const res = await fetch(`${API_URL}/public/share-links/${encodeURIComponent(linkId)}/token`, {
    method: "POST",
    credentials: "include",
    headers: password !== undefined ? { "content-type": "application/json" } : undefined,
    body: password !== undefined ? JSON.stringify({ password }) : undefined,
  });
  if (res.status === 401) return "password_required"; // needs a password
  if (res.status === 429) return "rate_limited"; // throttled — keep the prompt, show a cool-down notice
  if (!res.ok) return null;
  return (await res.json()) as GuestToken;
}
