// #628 whatever ceiling a tenant sets, the form can still issue a key.
//
// The reject measured a ceiling of 3 days producing ZERO options — the product refusing through its own
// form what its API accepts. So the ceilings are swept rather than sampled, and the two properties that
// matter are asserted for every one of them.
import { describe, it, expect } from "vitest";
import { expiryChoices, defaultExpiry } from "./key-expiry-choices";

const CEILINGS = [null, 0, 1, 2, 3, 7, 8, 30, 89, 90, 91, 365, 400, 3650] as const;

describe("#628: the expiry choices are derived from the ceiling, not filtered by it", () => {
  it.each(CEILINGS)("a ceiling of %s still offers something", (cap) => {
    const choices = expiryChoices(cap);
    expect(choices.length, `ceiling ${cap} left the form with nothing to choose`).toBeGreaterThan(0);
  });

  it.each(CEILINGS)("…and the default is one of them (a ceiling of %s)", (cap) => {
    const choices = expiryChoices(cap);
    const def = defaultExpiry(cap);
    expect(choices.map((c) => c.value), `the control would render blank at ceiling ${cap}`).toContain(def);
  });

  it.each(CEILINGS)("…and nothing offered exceeds the ceiling (%s)", (cap) => {
    for (const c of expiryChoices(cap)) {
      if (cap == null) continue; // no ceiling: "never" and every rung are all fine
      if (c.days === null) throw new Error(`ceiling ${cap} offered "never expires", which the server refuses`);
      expect(c.days, `${c.days} days is over the ${cap}-day ceiling`).toBeLessThanOrEqual(Math.max(1, cap));
    }
  });

  it("the ceiling itself is offered — a 3-day policy means 3-day keys", () => {
    expect(expiryChoices(3).map((c) => c.days)).toEqual([3]);
    expect(expiryChoices(2).map((c) => c.days)).toEqual([2]);
    // …and a ceiling that IS a rung is not offered twice
    expect(expiryChoices(90).map((c) => c.days)).toEqual([7, 30, 90]);
  });

  it("no ceiling keeps 'never' available, and it is the default", () => {
    expect(expiryChoices(null)[0]!.days).toBeNull();
    expect(defaultExpiry(null)).toBe("");
  });

  it("with a ceiling, the default is the longest thing allowed", () => {
    expect(defaultExpiry(3)).toBe("3");
    expect(defaultExpiry(90)).toBe("90");
    expect(defaultExpiry(400)).toBe("400");
  });
});
