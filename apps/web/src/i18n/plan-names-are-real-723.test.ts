// #723 (review bounce): shipped copy may only name plans that exist.
//
// The upgrade notice said "SCIM provisioning is a Business feature". There is no Business plan —
// the tier that carries `scim` is `team`, displayed as "Team", and the audit tab three files away
// says exactly that. The wrong name came from the ADR and the ticket, where "Business" was a
// habit, and nothing stopped it from being copied into a string a customer reads.
//
// A reviewer caught it by looking. This is what catches it next time: every capitalised plan-ish
// word in user-facing copy must be one the product actually displays.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

/** The names the product itself shows for plans (billing.plan_*), which is the only vocabulary
 *  copy may use. Derived, so a renamed tier updates this check with it. */
const displayed = (bundle: Record<string, unknown>): Set<string> => {
  const billing = (bundle as { billing?: Record<string, string> }).billing ?? {};
  return new Set(
    Object.entries(billing)
      .filter(([k]) => k.startsWith("plan_"))
      .map(([, v]) => v),
  );
};

/** Words that look like a tier being named. Deliberately a small list of the ones this product's
 *  market uses: a generic "capitalised word" scan would drown in false positives. */
const TIERISH = ["Business", "Enterprise", "Starter", "Premium", "Plus", "Professional"];

const strings = (bundle: unknown, path = ""): [string, string][] => {
  if (typeof bundle === "string") return [[path, bundle]];
  if (bundle && typeof bundle === "object") {
    return Object.entries(bundle as Record<string, unknown>).flatMap(([k, v]) =>
      strings(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
};

describe("#723: shipped copy only names plans that exist", () => {
  for (const [locale, bundle] of [["en", en], ["ja", ja]] as const) {
    it(`${locale}`, () => {
      const real = displayed(bundle as Record<string, unknown>);
      expect(real.size, "the plan display names must be readable, or this check is vacuous").toBeGreaterThanOrEqual(2);
      const offenders = strings(bundle)
        .filter(([, v]) => TIERISH.some((t) => !real.has(t) && new RegExp(`\\b${t}\\b`).test(v)))
        .map(([k, v]) => `${k}: ${v}`);
      expect(offenders, `use a plan name the product displays (${[...real].join(", ")})`).toEqual([]);
    });
  }
});
