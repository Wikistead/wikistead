// #686 (rulings+): the ADD offers are an INTERSECTION — (kinds the tenant accepts) ∩
// (kinds this browser can do) — and both surfaces read the same two predicates.
//
// Offering "add a passkey" where passkeys are not accepted invites somebody to enrol a factor that will
// not let them in (, "of course you'd hide it"); offering it in a browser without WebAuthn is an entrance
// that cannot be walked through at all. Each half of the defect had the same shape: the sign-in
// interstitial asked the question and the account panel did not, and two surfaces reading different
// copies of one fact is how they drifted. The first fix (stance) landed whilewas being written,
// so the capability half shipped un-asked on the panel — measured by the reviewer and bounced.
//
// ⚠️ NOT a defence. The endpoints still accept those enrolments and still mark them as not counting —
// this hides an entrance, it does not close one (#613). If they are to refuse outright, that is its own
// change with its own pin, and this file would then be measuring the weaker half.
//
// ⚠️ Kinds are not enumerated in the RULE. The walk covers every kind in ALL_FACTOR_KINDS under every
// stance and both capability states, computed from the two REAL predicates — a third kind is covered by
// the walk rather than by somebody remembering this file. (The capability predicate's own tests name
// "passkey", unavoidably: WebAuthn is what that kind depends on.)
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptedFactorKinds, browserCanUseFactorKind, ALL_FACTOR_KINDS } from "./factor-kind";

const PANEL = readFileSync(resolve(import.meta.dirname, "SecondFactorPanel.tsx"), "utf8");
const STEP = readFileSync(resolve(import.meta.dirname, "../app/FactorStep.tsx"), "utf8");
const KINDS = readFileSync(resolve(import.meta.dirname, "factor-kind.ts"), "utf8");

/** The intersection the panel's `canAdd` computes — from the REAL predicates, not a hand copy. */
const offered = (stance: string | null) =>
  ALL_FACTOR_KINDS.filter((k) => acceptedFactorKinds(stance).includes(k) && browserCanUseFactorKind(k));

const withWebAuthn = () => vi.stubGlobal("window", { PublicKeyCredential: class {} });
const withoutWebAuthn = () => vi.stubGlobal("window", {});
afterEach(() => vi.unstubAllGlobals());

describe("#686+what can be added is what is accepted AND possible", () => {
  for (const stance of [null, "off", "any", "passkey", "totp"] as const) {
    it(`${stance ?? "an older server"}: a capable browser is offered exactly the accepted set`, () => {
      withWebAuthn();
      expect(offered(stance)).toEqual(acceptedFactorKinds(stance).filter((k) => ALL_FACTOR_KINDS.includes(k as never)));
    });

    it(`${stance ?? "an older server"}: a browser without WebAuthn is offered the accepted set minus what it cannot do`, () => {
      // Computed, not enumerated: whichever kinds report themselves browser-independent must survive,
      // and whichever depend on the missing API must drop out — under EVERY stance, because "hide the
      // impossible" must not also hide the possible.
      withoutWebAuthn();
      const capable: readonly string[] = ALL_FACTOR_KINDS.filter((k) => browserCanUseFactorKind(k));
      expect(offered(stance)).toEqual(acceptedFactorKinds(stance).filter((k) => capable.includes(k)));
    });
  }

  it("the capability predicate actually reads the browser (the two-sided control)", () => {
    // Without a control, "always hide" passes every narrow case above (named this trap). The
    // WebAuthn-dependent kind must flip with the API; a kind with no browser dependency must not.
    withWebAuthn();
    const withApi = ALL_FACTOR_KINDS.filter((k) => browserCanUseFactorKind(k));
    withoutWebAuthn();
    const withoutApi = ALL_FACTOR_KINDS.filter((k) => browserCanUseFactorKind(k));
    expect(withApi, "with the API present, everything is possible").toEqual([...ALL_FACTOR_KINDS]);
    expect(withoutApi.length, "removing the API narrows the set").toBeLessThan(withApi.length);
    expect(withoutApi.length, "…but does not empty it — TOTP needs nothing from the browser").toBeGreaterThan(0);
    expect(browserCanUseFactorKind("passkey"), "passkey is the kind that depends on WebAuthn").toBe(false);
  });

  it("BOTH surfaces read the shared predicates — no private copies left", () => {
    // The defect, both times, was one surface asking its own copy of the question. Which JSX is
    // conditional is a source property, so it is read from the source.
    expect(PANEL).toContain("acceptedFactorKinds(stance).includes(kind) && browserCanUseFactorKind(kind)");
    expect(PANEL).toContain('canAdd("totp") && (');
    expect(PANEL).toContain('canAdd("passkey") && (');
    expect(STEP).toContain('browserCanUseFactorKind("passkey")');
    // The raw sync check lives in factor-kind.ts and NOWHERE else — a surface that re-asks the browser
    // directly (or via the library helper, the third copy this pin caught on landing) is a copy
    // waiting to drift. Comments are stripped first: prose about the API is not a reading of it.
    const codeOnly = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
    for (const [name, src] of [["SecondFactorPanel", PANEL], ["FactorStep", STEP]] as const) {
      expect(codeOnly(src), `${name} asks the browser directly instead of the shared predicate`).not.toContain("PublicKeyCredential");
      expect(codeOnly(src), `${name} asks via the library helper instead of the shared predicate`).not.toContain("browserSupportsWebAuthn");
    }
    expect(KINDS, "the predicate itself does the sync check").toContain('"PublicKeyCredential" in window');
    // …and the LIST is not gated on any of it: an existing factor stays visible and marked (#672 /
    // ADR-219 §7). Hiding what somebody already holds is a different act from declining to add more,
    // and it is the one ADR-219 §8 refused when SCIM proposed it.
    const list = PANEL.slice(PANEL.indexOf('data-testid="factor-row"'));
    expect(list.slice(0, 2000), "the row list was gated on the offer rule too").not.toContain("canAdd(");
  });

  it("a stance nobody narrowed, in a capable browser, offers everything", () => {
    // The control for the stance half: a `canAdd` that returned false by default would satisfy every
    // narrow case and leave a workspace with no way to enrol anything at all.
    withWebAuthn();
    expect(offered("any")).toEqual([...ALL_FACTOR_KINDS]);
    expect(offered(null), "no stance reported (older server)").toEqual([...ALL_FACTOR_KINDS]);
  });
});
