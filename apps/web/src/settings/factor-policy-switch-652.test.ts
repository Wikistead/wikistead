// #652 the second-factor requirement has a switch, on the screen that already holds the others.
//
// The browser spec measures the behaviour; what a source check adds is the thing a screenshot cannot
// tell apart — WHICH of the server's two refusals the row is reading. `entitled` and `canEnable` arrive
// separately for one reason, and a screen that greys the switch on either without saying which sends an
// admin to a pricing page when the fix is to enrol a factor. That is the reject's own words, and it is
// invisible in any run where the tenant happens to be entitled (every run today: `mfaPolicyEntitled`
// answers CE until #644 is ruled).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dirname, "AdminSignInMethodsSection.tsx"), "utf8");
/** Comments discuss both fields at length; the claim is about the code. */
const code = panel.split("\n").map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*|\{\/\*).*$/, "")).join("\n");
const row = (() => {
  const start = code.indexOf('data-testid="sign-in-method-second-factor-required"');
  expect(start, "the requirement has a row on the switchboard").toBeGreaterThan(0);
  return code.slice(start, code.indexOf("METHOD_ROW", start + 1) > 0 ? code.indexOf("{/* #589", start) : undefined);
})();

describe("#652: the policy is writable from the product", () => {
  it("writes it through the mutation, not through some other switch", () => {
    expect(/useUpdateSecondFactorRequired/.test(code), "the hook is used").toBe(true);
    expect(/second-factor-required-toggle/.test(row), "the row carries the switch").toBe(true);
  });

  it("draws the two refusals apart", () => {
    // Both branches present AND distinguishable. One testid for both states would satisfy a check that
    // only asked "is a reason shown".
    expect(/second-factor-unentitled/.test(row), "the plan refusal has its own mark").toBe(true);
    expect(/second-factor-no-admin/.test(row), "…and so does the enrolment one").toBe(true);
    expect(/entitled/.test(row) && /canEnable/.test(row), "the row reads both fields").toBe(true);
  });

  it("blocks ON only, never OFF", () => {
    // `canEnable` false with the policy already ON is the tenant whose last enrolled admin left. A
    // `disabled={!canEnable}` written without the `selected` term traps them under a requirement they
    // are allowed to lift — the server permits the OFF, and only the screen would refuse it.
    const disabled = row.slice(row.indexOf("disabled="), row.indexOf("onChange="));
    expect(/selected/.test(disabled), `the OFF direction stays open :: ${disabled.trim()}`).toBe(true);
  });

  it("asks before turning it on", () => {
    // Turning it on signs people out (ADR-219 §2). A switch that did that silently would be the same
    // click as every other toggle on the screen.
    expect(/setEnablingFactorPolicy\(true\)/.test(row), "ON opens the question").toBe(true);
    expect(/second-factor-required-confirm/.test(code), "…and there is something to confirm with").toBe(true);
  });
});
