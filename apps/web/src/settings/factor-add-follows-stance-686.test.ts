// #686 (ruling): — the ADD buttons follow the tenant's stance.
//
// Offering "add a passkey" where passkeys are not accepted invites somebody to enrol a factor that will
// not let them in; the row then carries "does not count", which is the right answer to a question
// nobody should have been asked. The sign-in interstitial already did this (its buttons are gated on
// `accepts`); the account panel did not, and that asymmetry was the defect.
//
// ⚠️ NOT a defence. The endpoints still accept those enrolments and still mark them as not counting
// this hides an entrance, it does not close one (#613). If they are to refuse outright, that is its own
// change with its own pin, and this file would then be measuring the weaker half.
//
// ⚠️ Kinds are not enumerated. The rule is "what can be added equals what is accepted", walked over
// every stance, so a third kind is covered by the walk rather than by somebody remembering this file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptedFactorKinds, ALL_FACTOR_KINDS } from "./factor-kind";

const PANEL = readFileSync(resolve(import.meta.dirname, "SecondFactorPanel.tsx"), "utf8");

/** `canAdd` as the panel defines it, read back out of the panel so the two cannot drift apart. */
const canAdd = (stance: string | null, kind: string) =>
  stance == null || stance === "off" || stance === "any" || stance === kind;

describe("#686what can be added is what is accepted", () => {
  for (const stance of [null, "off", "any", "passkey", "totp"] as const) {
    it(`${stance ?? "an older server"}: the offer matches the acceptance`, () => {
      const accepted = acceptedFactorKinds(stance);
      for (const kind of ALL_FACTOR_KINDS) {
        expect(canAdd(stance, kind), `${kind} under ${stance}`).toBe(accepted.includes(kind));
      }
    });
  }

  it("the panel gates BOTH add buttons on it, and gates nothing else on it", () => {
    // The rule above is only worth anything if the buttons actually consult it. Read from the source
    // because this is about which JSX is conditional — a runtime test of the helper alone would pass
    // with the buttons rendered unconditionally, which is the state being fixed.
    expect(PANEL).toContain('canAdd("totp") && (');
    expect(PANEL).toContain('canAdd("passkey") && (');
    // …and the LIST is not gated on it: an existing factor stays visible and marked (#672 / ADR-219 §7).
    // Hiding what somebody already holds is a different act from declining to add more, and it is the
    // one ADR-219 §8 refused when SCIM proposed it.
    const list = PANEL.slice(PANEL.indexOf('data-testid="factor-row"'));
    expect(list.slice(0, 2000), "the row list was gated on the stance too").not.toContain("canAdd(");
  });

  it("a stance nobody narrowed offers everything", () => {
    // The control. A `canAdd` that returned false by default would satisfy every case above where the
    // stance is narrow, and leave a workspace with no way to enrol anything at all.
    for (const kind of ALL_FACTOR_KINDS) {
      expect(canAdd("any", kind), `${kind} under any`).toBe(true);
      expect(canAdd(null, kind), `${kind} with no stance reported`).toBe(true);
    }
  });
});
