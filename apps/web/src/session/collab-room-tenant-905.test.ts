// @vitest-environment happy-dom
//
// #905: the collaboration room is named after the tenant the SERVER resolved, not a build-time
// constant. The defect: `tenantId` was `VITE_TENANT ?? "tenant_dev"`, so every member of every other
// tenant composed `t:tenant_dev:p:<page>` while their collab token named the real tenant — collab
// refused the room with "tenant mismatch", the editor stayed offline, and publish shipped the empty
// persisted draft as "published". Seen on the demo deployment; invisible in dev/e2e, whose only
// tenant IS tenant_dev.
import { describe, it, expect, vi } from "vitest";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

const ME_TENANT = "19bb5589-f194-4927-b702-aa99e46a6f34";

vi.mock("../data/apiClient", () => ({
  assetUrl: (p: string) => p,
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/auth/me") return { sub: "wlocal_abc", tenantId: ME_TENANT, isAdmin: false, displayName: "admin", picture: null };
    if (path === "/auth/collab-token") return { token: "header.e30.sig", expiresInSeconds: 300 };
    return null;
  }),
}));

const { SessionProvider, useSession } = await import("./SessionProvider");

describe("#905 the collab room's tenant comes from the session, not the build", () => {
  it("adopts the tenant /auth/me resolved from the Host", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: string[] = [];
    const Probe = () => {
      const s = useSession();
      useEffect(() => { seen.push(`${s.status}:${s.tenantId}`); }, [s.status, s.tenantId]);
      return null;
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(seen.at(-1), `session settled as ${seen.join(" → ")}`).toBe(`authed:${ME_TENANT}`);
    // Break-check: restore the constant and the last entry reads `authed:tenant_dev`.
    expect(seen.at(-1)).not.toContain("tenant_dev");
    await act(async () => { root.unmount(); });
  });
});
