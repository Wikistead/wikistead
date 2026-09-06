// @vitest-environment happy-dom
//
// #1107 / ADR-280 §2 (rev5 B2, rev6): `useMemberIdentitiesEnabled()` shares the SAME query as
// `useAdminSurfaces()` (one network request, `select` projects each caller's own slice) — and
// `useAdminSurfaces()` itself must keep returning a bare `string[]`, byte-for-byte the same shape its
// four existing call sites already read, unaffected by the new field riding the same response. rev5's
// own B2 finding was exactly this class of regression (a mechanical `.data` → `.data.surfaces` replace
// would have crashed an in-flight/errored caller) — this pins the fix rather than the mistake.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const calls: { queryKey: unknown; select?: (r: unknown) => unknown }[] = [];
let response: { surfaces: string[]; memberIdentitiesEnabled: boolean } | undefined;

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown; select?: (r: unknown) => unknown }) => {
    calls.push({ queryKey: opts.queryKey, select: opts.select });
    const data = response === undefined ? undefined : (opts.select ? opts.select(response) : response);
    return { data, isPending: response === undefined, isError: false };
  },
}));
vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "t", status: "authed" }) }));
vi.mock("./apiClient", () => ({ apiFetch: async () => response, assetUrl: (p: string) => p }));

const { useAdminSurfaces, useMemberIdentitiesEnabled } = await import("./queries");

function SurfacesProbe() {
  const q = useAdminSurfaces();
  return createElement("div", { "data-testid": "surfaces", "data-value": JSON.stringify(q.data) });
}
function EnabledProbe() {
  const q = useMemberIdentitiesEnabled();
  return createElement("div", { "data-testid": "enabled", "data-value": String(q.data) });
}

afterEach(() => { vi.clearAllMocks(); calls.length = 0; response = undefined; });

describe("#1107: useAdminSurfaces and useMemberIdentitiesEnabled share one query, each projecting its own slice", () => {
  it("both hooks use the identical queryKey — one network request, per TanStack's own dedup-by-key", () => {
    response = { surfaces: ["members"], memberIdentitiesEnabled: true };
    renderToStaticMarkup(createElement(SurfacesProbe));
    renderToStaticMarkup(createElement(EnabledProbe));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.queryKey).toEqual(calls[1]!.queryKey);
  });

  it("useAdminSurfaces() still returns a bare string[] — unaffected by the new field on the same response", () => {
    response = { surfaces: ["members", "auth"], memberIdentitiesEnabled: true };
    const html = renderToStaticMarkup(createElement(SurfacesProbe));
    expect(html).toContain('data-value="[&quot;members&quot;,&quot;auth&quot;]"');
  });

  it("useMemberIdentitiesEnabled() projects the new field, not the surfaces array", () => {
    response = { surfaces: [], memberIdentitiesEnabled: true };
    const html = renderToStaticMarkup(createElement(EnabledProbe));
    expect(html).toContain('data-value="true"');
  });

  it("an in-flight (undefined) response leaves useAdminSurfaces().data undefined, never a crash reading .surfaces off nothing", () => {
    response = undefined;
    expect(() => renderToStaticMarkup(createElement(SurfacesProbe))).not.toThrow();
  });
});
