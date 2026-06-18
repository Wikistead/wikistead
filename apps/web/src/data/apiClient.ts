// Thin authenticated fetch wrapper for the chrome (sidebar/tree/search/etc.).
// The tenant is resolved server-side from the request Host (dev: localhost ->
// tenant_dev), so callers only supply the bearer token. Screens in the next
// stage build their queries on top of this (the data-fetching library is
// deferred until the first screen's requirements are known — ADR-013).
const API_URL = (import.meta as any).env?.VITE_API_URL ?? "http://localhost:4000";

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
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, path, `API ${res.status} for ${path}`);
  }
  return res.status === 204 ? null : ((await res.json()) as T);
}
