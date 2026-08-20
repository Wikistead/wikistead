// #808: a signed-out visitor opened the workspace root and was told "no spaces yet — ask an
// administrator to add you". Measured on a cookie-less browser (2026-08-21): every call the page made
// answered 401 and the screen still spoke to a member. The same held for /templates ("no templates
// yet, save one from a page's menu"), /changes and /watches. A visitor cannot tell they are signed out.
//
// Two sibling routes had the branch all along — a page and a space each return the sign-in screen for
// `status === "anon"` — so this was not a missing idea, it was four addresses that never got it. That is
// the shape a hand-applied rule takes: the fifth address will not get it either.
//
// So the rule is asked of the TABLE. Every Route is either an address a signed-out visitor may reach —
// declared, with its reason, in ANONYMOUS_ROUTES — or it is member UI wrapped in RequireMember. A route
// added later cannot inherit the empty desk by saying nothing; it has to say which it is.
//
// ⚠️ Invisible in development: apps/web/.env.development sets VITE_DEV_TOKEN, so the session begins
// "authed" and the anonymous branch never renders. VITE_DEV_TOKEN_DISABLE=1 is how it is seen.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");

/** Every `<Route path="…" …>` in the table, mapped to the line it sits on. */
function routeLines(): Map<string, string> {
  const out = new Map<string, string>();
  // Single-line tags: all twenty are written that way, and the count assertion below is what makes
  // that a checked fact rather than an assumption — a multi-line tag would drop out of this map.
  for (const m of SRC.matchAll(/<Route path="([^"]+)"[^\n]*/g)) out.set(m[1]!, m[0]);
  return out;
}

/** The declared anonymous addresses, read from the source's own ledger (not a copy of it). */
function declaredAnonymous(): Set<string> {
  const start = SRC.indexOf("export const ANONYMOUS_ROUTES");
  expect(start, "the ledger must exist in routes.tsx").toBeGreaterThan(0);
  const block = SRC.slice(start, SRC.indexOf("};", start));
  return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]!));
}

describe("#808 every address says whether a signed-out visitor may be there", () => {
  const routes = routeLines();

  it("read the whole table", () => {
    // If a Route is ever written across two lines it silently leaves the map above, and every
    // assertion below would pass by not looking at it.
    expect(routes.size).toBe((SRC.match(/<Route /g) ?? []).length);
    expect(routes.size).toBeGreaterThan(15);
  });

  it("has no route that is neither declared anonymous nor guarded", () => {
    const anonymous = declaredAnonymous();
    const unaccounted = [...routes]
      .filter(([path, line]) => !anonymous.has(path) && !line.includes("RequireMember"))
      .map(([path]) => path);
    expect(
      unaccounted,
      "wrap it in RequireMember, or add it to ANONYMOUS_ROUTES with the reason a signed-out visitor may be there",
    ).toEqual([]);
  });

  it("declares a reason for every anonymous address, and declares no address twice", () => {
    const anonymous = declaredAnonymous();
    for (const path of anonymous) {
      const block = SRC.slice(SRC.indexOf("export const ANONYMOUS_ROUTES"));
      const entry = new RegExp(`"${path.replace(/[/*:]/g, "\\$&")}":\\s*"([^"]+)"`).exec(block);
      expect(entry?.[1] ?? "", `${path} needs a reason, not just a place in the list`).not.toHaveLength(0);
      // A route cannot be both open to anonymous visitors and guarded against them.
      expect(routes.get(path) ?? "", `${path} is declared anonymous AND guarded`).not.toContain("RequireMember");
    }
    // …and the ledger must not name addresses the table does not have (a stale entry would excuse a
    // route that no longer exists, and quietly excuse a new one that reuses the path).
    expect([...anonymous].filter((p) => !routes.has(p)), "stale entries in ANONYMOUS_ROUTES").toEqual([]);
  });

  it("sends an anonymous visitor to the sign-in screen rather than an empty desk", () => {
    const guard = SRC.slice(SRC.indexOf("function RequireMember"), SRC.indexOf("export const ANONYMOUS_ROUTES"));
    expect(guard, "anon must render the door").toMatch(/status === "anon"\)\s*return <LoginScreen \/>/);
    // …and must not paint a member's empty state while the session is still resolving.
    expect(guard, "loading must not fall through to member UI").toContain('status === "loading"');
  });
});
