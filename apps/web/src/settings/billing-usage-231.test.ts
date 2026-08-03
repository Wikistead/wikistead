// #231: showing what has been metered. The counters have existed since #383 and the endpoint since
// 2026-07-27; what was missing was any way to SEE them.
//
// Two things are worth pinning, and neither is "does it render". The first is that `allowance: null`
// means UNLIMITED — printing it through a number formatter would say "0", which is the opposite of
// what it means, and that mistake is invisible until a self-hosted deployment reads its own screen.
// The second is what this screen must NOT grow: prices, cap constants, warnings or nagging. What
// counts as "too much" is a pricing ruling (#127), and a screen that decided it first would be
// deciding it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const src = readFileSync(resolve(import.meta.dirname, "./AdminBillingTab.tsx"), "utf8");

describe("#231: the usage section says what is metered, and nothing about price", () => {
  it("unlimited and limited are different sentences, not a formatting branch", () => {
    // The dangerous shape is `fmt.format(r.allowance ?? 0)` — one sentence, a null coerced to zero.
    expect(src).toContain("r.allowance === null");
    expect(src).toContain("billing.usedUnlimited");
    expect(src).toContain("billing.usedOf");
    expect(src, "no null-coalescing an allowance into a number").not.toMatch(/allowance\s*\?\?\s*0/);
  });

  it("an empty resource list renders nothing rather than an empty box", () => {
    expect(src).toContain("if (resources.length === 0) return null");
  });

  it("it appears on self-host too — metering runs there, and the question is still real", () => {
    // Two mounts: the self-hosted early return and the Cloud branch.
    expect(src.match(/<UsageSection resources=/g)?.length, "both branches show it").toBe(2);
  });

  it("no price, no cap constant, no warning threshold lives on this screen (#127's rulings)", () => {
    // Read the CODE, not the prose: this file's own comments say what the screen must not grow, and a
    // pin that searched the comments too would forbid explaining itself.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    for (const forbidden of [/\bprice\b/i, /\bper[- ]?token\b/i, /threshold/i, /\bwarn/i, /exceed/i]) {
      expect(code, `${forbidden} belongs to the pricing ruling, not to this screen`).not.toMatch(forbidden);
    }
    // and no bare cap-shaped number sitting next to a usage figure
    expect(code).not.toMatch(/allowance\s*[><]=?\s*\d/);
  });

  it("the fetch does not retry a 403 into a spinner", () => {
    // A non-admin gets 403; retrying it would spin forever and say nothing.
    const q = readFileSync(resolve(import.meta.dirname, "../data/queries.ts"), "utf8");
    const block = q.slice(q.indexOf("export function useBillingUsage"), q.indexOf("export function useCheckout"));
    expect(block).toContain("retry: false");
    expect(block).toContain('"/billing/usage"');
  });

  it("both locales carry the usage copy, including the unlimited wording", () => {
    for (const loc of [en, ja] as Array<{ billing: Record<string, string> }>) {
      for (const k of ["usageTitle", "usedOf", "usedUnlimited", "resource_ai.tokens", "resource_other"]) {
        expect(loc.billing[k], k).toBeTruthy();
      }
      expect(loc.billing.usedOf).toContain("{{allowance}}");
      expect(loc.billing.usedUnlimited, "the unlimited wording must not print an allowance").not.toContain("{{allowance}}");
    }
  });
});
