// @vitest-environment happy-dom
//
// #886: the public page tells a restart apart from a page that is not there.
//
// THE DEFECT: the load mapped every non-OK response — and every rejected fetch — to "page not found".
// A 502 from a rolling restart therefore told a reader that the address their author shared does not
// exist, and a reader has no way to tell that from a broken link. This is the outermost surface the
// product has; "Publish anywhere" is the pillar it serves.
//
// ⚠️ THE 404 IS NOT A BUG AND MUST NOT MOVE. It is existence-hiding (#227): a page a reader may not
// see has to be indistinguishable from one that was never there. So the fix is exactly the line #681
// already drew for the sign-in screens — the server failing is not an answer about the reader — and
// nothing else. A version of this change that softened the 404 would trade a cosmetic problem for a
// disclosure, which is why the case below drives that direction too.
//
// There is no renderer in this package, so the wiring is read from the source. That is faithful here
// because the branch order is the whole mechanism: the not-found branch is what the new state has to
// come BEFORE, and an ordering is exactly what source position shows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isServerFault } from "./serverFault";

const SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");
const at = (marker: string): number => {
  const i = SRC.indexOf(marker);
  expect(i, `${marker} is not in routes.tsx`).toBeGreaterThan(-1);
  return i;
};

describe("#886 a restarting deployment is not a missing page", () => {
  it("asks the one predicate the sign-in screens ask, rather than inventing a second", () => {
    // #681 wrote isServerFault precisely so four surfaces could not drift apart. This is the fifth.
    expect(SRC).toContain('import { isServerFault } from "./serverFault"');
    expect(SRC).toContain('if (isServerFault(res)) { setState({ status: "unavailable" }); return; }');
  });

  it("checks it BEFORE the not-found branch", () => {
    // Placed after, it would never run: a 5xx is also `!res.ok`, so the reader would see the old
    // sentence and the new state would be dead code.
    expect(at('if (isServerFault(res)) { setState({ status: "unavailable" }); return; }'))
      .toBeLessThan(at('if (!res.ok) { setState({ status: "notfound" }); return; }'));
  });

  it("keeps the not-found branch, because existence-hiding lives in it (#227)", () => {
    // The direction this change must NOT take. A 404 that started saying "try again in a moment"
    // would tell a stranger that the page exists and they simply may not see it.
    expect(SRC).toContain('if (!res.ok) { setState({ status: "notfound" }); return; }');
    expect(isServerFault({ status: 404 } as Response), '404 is an answer about the page').toBe(false);
    expect(isServerFault({ status: 403 } as Response), 'so is a refusal').toBe(false);
  });

  it("treats a request that never arrived the same way", () => {
    expect(SRC).toContain('.catch(() => { if (!cancelled) setState({ status: "unavailable" }); });');
    expect(isServerFault(null), 'no response is not a fact about the page').toBe(true);
  });

  it("renders the new state before the not-found one, and offers a way back", () => {
    expect(at('state.status === "unavailable"')).toBeLessThan(at('state.status === "notfound"'));
    // The whole difference from the not-found view: this one is recoverable, so it has to be able to
    // ask again — otherwise it is the same dead end in kinder words.
    expect(at('data-testid="public-unavailable-retry"')).toBeGreaterThan(at('data-testid="public-unavailable"'));
    expect(SRC).toMatch(/public-unavailable-retry[\s\S]{0,200}setReloadKey/);
    // …and the retry has to actually re-run the load.
    expect(SRC).toContain('}, [pageId, reloadKey]);');
  });

  it("says it in both locales, and the Japanese is not the English", () => {
    const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    const ja = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const key of ["unavailable", "unavailableRetry"]) {
      expect(en.publicPage?.[key], `en is missing publicPage.${key}`).toBeTruthy();
      expect(ja.publicPage?.[key], `ja is missing publicPage.${key}`).toBeTruthy();
      expect(ja.publicPage![key], `ja.publicPage.${key} is still the English string`).not.toBe(en.publicPage![key]);
    }
    // The sentence has one job beyond apologising: tell the reader the address is not the problem.
    expect(en.publicPage!.unavailable).toMatch(/link is fine/i);
    expect(ja.publicPage!.unavailable).toContain("リンク自体は有効");
    // …and the not-found wording stays what it was.
    expect(en.publicPage!.notFound).toBe("Page not found");
  });
});
