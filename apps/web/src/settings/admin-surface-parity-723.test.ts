// #723 / ADR-232 §1: the server's surface registry and the console's own tables must name the same
// surfaces.
//
// ADR-208 promises that adding a VERB needs no second edit. Adding a SURFACE is different, and the
// difference had no guard: `ADMIN_SURFACES` decides which surfaces the server opens, while
// `useAdminTabs()` and the `<Route>` list in AdminPage.tsx are hand-written. Either half can go
// missing without a red anywhere —
//
//   registry only → the server opens a surface nothing renders (a tab nobody can reach);
//   client only  → a tab whose Surface guard never sees it listed, so it renders "forbidden" forever.
//
// Neither is loud. The first ships as "the feature is done" with no way in, which is the shape #723
// itself was: SCIM's routes existed for months and no screen mentioned them.
//
// The comparison reads AdminPage.tsx as TEXT, the way doc-coverage-697 reads routes.tsx: importing
// it would drag React, the router and the whole settings tree into a unit test to learn two lists.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Read as TEXT, like AdminPage.tsx below. Importing the module would pull the server's Fastify
// types into the web typecheck (measured: three errors about `app.fga`, from a file this test only
// wants two dozen keys out of). The count assertion below is what keeps a mis-parse from passing.
const registrySrc = readFileSync(resolve(import.meta.dirname, "../../../server/src/routes/admin-surfaces.ts"), "utf8");
const registryBody = registrySrc.slice(registrySrc.indexOf("export const ADMIN_SURFACES"));
const ADMIN_SURFACES: Record<string, string> = Object.fromEntries(
  [...registryBody.slice(0, registryBody.indexOf("}")).matchAll(/^\s*([a-z]+):\s*'([a-z_]+)',/gm)].map((m) => [m[1], m[2]]),
);

const page = readFileSync(resolve(import.meta.dirname, "./AdminPage.tsx"), "utf8");

/** Tab keys and where they point: `{ key: "orphans", label: …, to: "/admin/orphan-drafts" }`. */
const tabs = [...page.matchAll(/\{\s*key:\s*"([a-z-]+)",\s*label:[^}]*?to:\s*"([^"]+)"/g)]
  .map((m) => ({ key: m[1], to: m[2] }));
const tabKeys = tabs.map((t) => t.key);
/** Routed paths, and the surface each one guards under. The URL segment is NOT required to equal
 *  the surface key — `orphans` is routed at /admin/orphan-drafts and that is fine, because the tab
 *  points there and the guard still names `orphans`. What must hold is that the three agree. */
const routes = [...page.matchAll(/<Route\s+path="([a-z-]+)"\s+element=\{<Surface\s+name="([a-z-]+)"/g)]
  .map((m) => ({ path: m[1], surface: m[2] }));
const routePaths = routes.map((r) => r.path);
const surfaceNames = routes.map((r) => r.surface);

describe("#723: the admin console renders exactly the surfaces the server registers", () => {
  it("the walk found the real tables (a broken reader must not pass vacuously)", () => {
    expect(tabKeys.length).toBeGreaterThanOrEqual(10);
    expect(routePaths.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(ADMIN_SURFACES).length).toBeGreaterThanOrEqual(10);
  });

  it("every registered surface has a tab and a guarded route", () => {
    const missingTab = Object.keys(ADMIN_SURFACES).filter((s) => !tabKeys.includes(s));
    const missingRoute = Object.keys(ADMIN_SURFACES).filter((s) => !surfaceNames.includes(s));
    expect(missingTab, "the server would open a surface the console never offers").toEqual([]);
    expect(missingRoute, "the tab would lead to a route that renders nothing").toEqual([]);
  });

  it("every tab and guarded route belongs to a registered surface", () => {
    const strayTabs = tabKeys.filter((k) => !(k in ADMIN_SURFACES));
    const strayRoutes = surfaceNames.filter((n) => !(n in ADMIN_SURFACES));
    expect(strayTabs, "a tab the server never lists renders as forbidden, forever").toEqual([]);
    expect(strayRoutes, "a route guarding under an unregistered name can only answer forbidden").toEqual([]);
  });

  it("each tab points at a route that exists", () => {
    const dangling = tabs.filter((t) => !routePaths.includes(t.to.replace(/^\/admin\//, "")));
    expect(dangling.map((t) => `${t.key} → ${t.to}`), "a tab whose href has no route lands on nothing").toEqual([]);
  });
});
