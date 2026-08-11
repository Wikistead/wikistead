// #687: what the DOOR offers is what the member can actually present.
//
// A real YubiKey found the lock-out: the second step drew a six-digit box and nothing else, so
// somebody whose only factor was a security key had nothing to do. The server had accepted assertions
// at that door since #665; the screen never called them. That is the third time this shape landed on
// this feature (#653 dropped a `uri` the server sent, #666 rebuilt options the server had minted) and
// the only one that keeps a person out.
//
// ⚠️ The rule is a SET EQUALITY, not "the passkey button exists": a pin naming one kind goes silent in
// the mirror-image tenant (#686 hit exactly that). Every kind the server reports as presentable must
// have a way to answer, and nothing else may be offered.
//
// ⚠️ THIS FILE CANNOT PROVE THE FEATURE WORKS. It reads source: it can see that the door calls the
// assertion routes and gates each affordance on the kind, but "the key was presented and a session came
// back" is a browser ceremony. `passkey-signin-687.spec.ts` walks it end to end (enrol → sign out →
// sign in with only the key), because #666 shipped eight green refusal assertions over a broken
// accepting path.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_FACTOR_KINDS } from "../settings/factor-kind";

const STEP = readFileSync(resolve(import.meta.dirname, "FactorStep.tsx"), "utf8");
const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/en.json"), "utf8"));
const ja = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/ja.json"), "utf8"));

/** The `required` branch only — the enrolment branch answers a different question (#686). */
const requiredBranch = (() => {
  const start = STEP.indexOf('stage === "required" ? (');
  expect(start, "the required branch was found").toBeGreaterThan(-1);
  const end = STEP.indexOf(") : enrolling ? (", start);
  expect(end, "…and its end").toBeGreaterThan(start);
  return STEP.slice(start, end);
})();

describe("#687: the door offers what the member holds", () => {
  it("every kind has an affordance in the required branch, and each is gated on that kind", () => {
    // Computed from the kind list, so a third kind is covered by the walk rather than by somebody
    // remembering this file. `accepts(k)` is the door's own predicate over the server's `kinds`.
    for (const kind of ALL_FACTOR_KINDS) {
      expect(requiredBranch, `the door has no gate for ${kind} — it offers it unconditionally, or not at all`)
        .toContain(`accepts("${kind}")`);
    }
  });

  it("the passkey affordance actually presents — it calls the routes #665 shipped", () => {
    expect(STEP, "the door never asks for an assertion challenge").toContain("/auth/local/factor/passkey/options");
    expect(STEP, "the browser ceremony is never run at the door").toContain("startAuthentication");
    // The options are used AS RECEIVED. Rebuilding them client-side is the #666 defect, and it fails
    // in a way that looks like a broken key rather than a broken screen.
    expect(STEP, "the door rebuilds the options instead of passing them through")
      .not.toMatch(/optionsJSON:\s*\{/);
    expect(STEP, "the assertion is not sent to the factor endpoint").toMatch(/post\("\/auth\/local\/factor",\s*\{\s*passkey:/);
  });

  it("the code box belongs to somebody who can answer with a code", () => {
    // #606: a control whose only possible outcome is a refusal. Under a passkey-only member the box
    // was the ONLY thing on screen, which is the lock-out itself.
    expect(requiredBranch, "the code box is drawn regardless of what the member can present")
      .toMatch(/accepts\("totp"\)\s*&&\s*codeBox\(/);
  });

  it("the prompt names the kinds rather than one hard-coded kind", () => {
    expect(requiredBranch, "the prompt does not interpolate the kinds").toContain("factorKindsPhrase(kinds, t)");
    for (const [lang, dict] of [["en", en], ["ja", ja]] as const) {
      const copy: string = dict.auth.factorPrompt;
      expect(copy, `${lang}: the prompt does not take the kinds`).toContain("{{kinds}}");
      // The old sentence named the authenticator app unconditionally — to somebody holding a key.
      expect(copy.toLowerCase(), `${lang}: the prompt still names one kind in prose`)
        .not.toMatch(/authenticator|認証アプリ|passkey|パスキー/);
    }
  });

  it("a browser without WebAuthn is told, rather than shown an empty panel", () => {
    // Same ruling as the enrolment side (#672 ③): the lock-out is accepted, the silence is not.
    expect(requiredBranch).toContain('data-testid="login-factor-unsupported"');
    for (const [lang, dict] of [["en", en], ["ja", ja]] as const) {
      expect(dict.auth.factorNoWebauthn?.length, `${lang}: the lock-out sentence is missing`).toBeGreaterThan(10);
      // It is now shown on BOTH surfaces, so it may not talk about registering only.
      expect(dict.auth.factorNoWebauthn.toLowerCase(), `${lang}: the sentence only fits the enrolment side`)
        .not.toMatch(/register|登録/);
    }
  });
});
