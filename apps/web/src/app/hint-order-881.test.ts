// @vitest-environment happy-dom
//
// #881 (from the #807 review): each hint sits under the field it describes, and something says so.
//
// THE DEFECT #807 FIXED: the display-name hint sat at the FOOT of the form, two inputs below the field
// it explains — a reader met "this is the name others will see" only after typing a password twice.
// e9c0fbb4 moved it. Nothing then held it there: `invite-display-name-807.test.ts` asserts the value
// and the request, never a position, and the e2e only fills the field. The same regression would have
// been green everywhere.
//
// ⚠️ WHAT THIS MEASURES, AND WHAT IT DOES NOT. There is no real-DOM renderer in this package
// (`@testing-library/react` is not a dependency here, and adding one is a licence gate plus a review),
// so the order is read from the SOURCE. That is faithful for this form and not in general: every
// element below is a plain sibling in one JSX return, and the display-name pair sits inside a single
// `mode === "accept"` branch that contains both of its members — so nothing can reorder the rendered
// output without reordering these lines. A form that grew a wrapper, a portal or a CSS `order` would
// break that correspondence, and this comment is where the next reader finds that out.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "SetPasswordForm.tsx"), "utf8");

/** Where each marker appears in the file, in source order. A marker that is absent throws by name. */
function at(marker: string): number {
  const i = SRC.indexOf(marker);
  expect(i, `${marker} is not in SetPasswordForm.tsx — this pin is about WHERE it is, so its absence is also a failure`).toBeGreaterThan(-1);
  return i;
}

describe("#881 the invite form explains each field where the reader meets it", () => {
  it("the display-name hint follows its own field, not the whole form", () => {
    const field = at('data-testid="set-password-display-name"');
    const hint = at('t("auth.displayNameHint")');
    const password = at('data-testid="set-password-input"');
    expect(hint, "the hint must come after the field it explains").toBeGreaterThan(field);
    expect(hint, "...and BEFORE the password, which is where it used to be stranded").toBeLessThan(password);
  });

  it("the password hint follows the pair of password fields", () => {
    const confirm = at('data-testid="set-password-confirm"');
    const hint = at('t("auth.passwordHint"');
    const submit = at('data-testid="set-password-submit"');
    expect(hint).toBeGreaterThan(confirm);
    expect(hint, "a rule about the password is no use after the button that accepts it").toBeLessThan(submit);
  });

  it("the two hints are distinct and in the order their fields are", () => {
    // The cheap wrong pin asserts both strings are present. This one fails when they swap places,
    // which is the shape a copy-paste refactor produces.
    expect(at('t("auth.displayNameHint")')).toBeLessThan(at('t("auth.passwordHint"'));
  });

  it("the whole form reads field, its hint, field, field, its hint, submit", () => {
    // Named as one sequence as well as pairwise: a single reordered line is caught above, and a
    // wholesale rewrite that keeps every pair but shuffles the groups is caught here.
    const order = [
      'data-testid="set-password-display-name"',
      't("auth.displayNameHint")',
      'data-testid="set-password-input"',
      'data-testid="set-password-confirm"',
      't("auth.passwordHint"',
      'data-testid="set-password-submit"',
    ].map(at);
    expect(order, `the form's reading order changed: ${order.join(" < ")}`).toEqual([...order].sort((a, b) => a - b));
  });
});
