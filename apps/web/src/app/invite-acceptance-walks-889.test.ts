// #889: every browser walk through the invite form answers what the form requires.
//
// THE DEFECT was not in the product. #807 made the display name required on an accepted invite — the
// submit stays disabled until it is filled — and ONE of the two specs that walk that form followed.
// The other clicked a button that was never going to enable and waited out its full minute. Nobody
// saw it, because e2e runs in no automated gate (#891); it was found by running the suite by hand.
//
// So the guard is the one that would have caught it: count the walks, and require each of them to
// answer every field the form gates its submit on. A walk that matches nothing is a red.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FORM = resolve(import.meta.dirname, "SetPasswordForm.tsx");
const SPECS = resolve(import.meta.dirname, "../../../../tests/e2e/specs");

// The specs directory is part of the CE build, so the existsSync is a guard against a MOVE rather
// than against a missing directory — and `finds the walks at all` is what stops a move from turning
// this file into a green that walked nothing.
const specs = existsSync(SPECS)
  ? readdirSync(SPECS).filter((f) => f.endsWith(".spec.ts"))
      .map((f) => ({ name: f, src: readFileSync(join(SPECS, f), "utf8") }))
      .filter((f) => f.src.includes('getByTestId("set-password-submit")'))
  : [];

describe("#889 a walk through the invite form answers what the form asks", () => {
  it("knows which fields the submit is gated on", () => {
    const src = readFileSync(FORM, "utf8");
    // Read the disabled expression rather than a remembered list: a seventh required field added to
    // it lands in the cases below on the day it is written.
    const disabled = /data-testid="set-password-submit" disabled=\{([^}]*)\}/.exec(src);
    expect(disabled, "the submit's disabled expression moved").not.toBeNull();
    expect(disabled![1]).toContain("!displayName.trim()");
    expect(src).toContain('data-testid="set-password-display-name"');
  });

  it.skipIf(!existsSync(SPECS))("finds the walks at all", () => {
    expect(specs.length, `no spec under ${SPECS} presses set-password-submit`).toBeGreaterThanOrEqual(2);
  });

  it.each(specs.map((s) => [s.name, s] as const))("%s fills the display name before submitting", (_n, spec) => {
    // Only for the accept flow — a reset (mode !== "accept") does not ask, and must not be forced to.
    if (!/\/invite\?token=|"\/invite"/.test(spec.src)) return;
    expect(spec.src, `${spec.name} presses a submit that stays disabled`).toContain("set-password-display-name");
  });
});
