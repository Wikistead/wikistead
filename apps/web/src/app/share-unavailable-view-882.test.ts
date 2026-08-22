// @vitest-environment happy-dom
//
// #882, the other half: the answer has to reach the screen.
//
// Splitting "not now" from "revoked" in the client changes nothing on its own — the route mapped
// EVERY non-token answer to the dead-link view, so a new value would have landed there too and the
// visitor would have read the same sentence. This measures the route's own wiring, without a
// renderer: the source is read for the branch and the order it sits in.
//
// ⚠️ ORDER IS THE POINT. The dead-link branch is `state.status === "denied" || !state.minted`, and
// the transient state has no `minted` — so a transient branch placed AFTER it never runs, and the
// visitor reads "this link is invalid" exactly as before. That is the shape a careless fix takes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");
const at = (marker: string): number => {
  const i = SRC.indexOf(marker);
  expect(i, `${marker} is not in routes.tsx`).toBeGreaterThan(-1);
  return i;
};

describe("#882 the share route tells the two failures apart", () => {
  it("has a state for 'not now' that is not 'denied'", () => {
    expect(SRC).toContain('"loading" | "denied" | "unavailable" | "password" | "ok"');
  });

  it("maps the client's transient answer to it, on BOTH entry paths", () => {
    // One is the first load, the other the password submit. Fixing one and not the other leaves half
    // the visitors reading the wrong sentence — and the halves are not symmetric, so one test each.
    const hits = [...SRC.matchAll(/minted === "unavailable"/g)];
    expect(hits.length, "both the first exchange and the password attempt must map it").toBe(2);
  });

  it("renders that state BEFORE the dead-link branch", () => {
    // The dead-link branch also fires on `!state.minted`, and the transient state carries none.
    expect(at('state.status === "unavailable"')).toBeLessThan(at('state.status === "denied" || !state.minted'));
  });

  it("offers a way out, rather than a sentence", () => {
    // The whole difference from the dead-link view: this one is recoverable, so it must be able to
    // ask again — otherwise it is the same dead end wearing kinder words.
    expect(at('data-testid="share-unavailable-retry"')).toBeGreaterThan(at('data-testid="share-unavailable"'));
    expect(SRC).toMatch(/share-unavailable-retry[\s\S]{0,200}attempt\(/);
  });

  it("says it in both locales, and the Japanese is not a gloss of the English", () => {
    const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    const ja = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const key of ["unavailable", "unavailableRetry"]) {
      expect(en.share?.[key], `en is missing share.${key}`).toBeTruthy();
      expect(ja.share?.[key], `ja is missing share.${key}`).toBeTruthy();
      expect(ja.share![key], `ja.share.${key} is still the English string`).not.toBe(en.share![key]);
    }
    // The sentence has one job beyond apologising: tell the reader their link is not the problem.
    expect(en.share!.unavailable).toMatch(/link is fine/i);
    expect(ja.share!.unavailable).toContain("リンク自体は有効");
  });
});
