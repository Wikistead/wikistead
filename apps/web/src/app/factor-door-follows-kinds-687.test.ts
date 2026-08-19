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
//
// ⚠️ #745 / ADR-240 changed the SHAPE this file used to read. The door now draws a chooser over the
// same set instead of stacking one affordance per kind, and the owner's ruling deleted the
// prompt sentence because a button that says "authenticator app" already said it. The PROPERTY is
// untouched and is what this file still holds: the door offers exactly the kinds the server reported
// as presentable — no more (a disclosure), no fewer (a lock-out). The assertions moved from the old
// `accepts(kind)` spelling to the derivation that replaced it, which is a stronger place to stand
// `doorProofs` is a function a test can drive, where the old form could only be read as text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_FACTOR_KINDS } from "../settings/factor-kind";
import { doorProofs } from "./FactorStep";

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
  it("every kind the server reports is offered, and nothing else is", () => {
    // Computed from the kind list, so a third kind is covered by the walk rather than by somebody
    // remembering this file. The set equality is the rule — a pin naming one kind goes silent in the
    // mirror-image tenant (#686 hit exactly that).
    for (const kind of ALL_FACTOR_KINDS) {
      expect(doorProofs([kind], true), `the door drops ${kind} even though the server sent it`).toEqual([kind]);
      const others = ALL_FACTOR_KINDS.filter((k) => k !== kind);
      for (const other of others) {
        expect(doorProofs([kind], true), `the door offers ${other}, which this member cannot present`).not.toContain(other);
      }
    }
    expect(doorProofs([...ALL_FACTOR_KINDS], true).sort()).toEqual([...ALL_FACTOR_KINDS].sort());
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
    // was the ONLY thing on screen, which is the lock-out itself. In the chooser shape the box is
    // reached by PICKING totp, and totp can only be picked when the server offered it — so the gate
    // is the derivation above plus this: the box is drawn for the picked kind, never unconditionally.
    expect(requiredBranch, "the code box is drawn regardless of which proof was chosen")
      .toMatch(/picked === "totp" && codeBox\(/);
    expect(doorProofs(["passkey"], true), "totp is offered to a member who cannot present it").not.toContain("totp");
  });

  it("the screen names the kinds rather than one hard-coded kind", () => {
    // #686 put the kind nouns in an interpolated sentence, because the old prose named the
    // authenticator app to somebody holding a key. #745 / ADR-240 deleted that sentence (owner ruling
    //) — but only because the CHOOSER now says it: each button names the kind it stands for.
    // The property is the same one, held one layer down, so this asserts the buttons carry per-kind
    // copy and that neither locale hard-codes a kind in a sentence around them.
    // The chooser labels each entry with the PRODUCT's noun for that kind, taken from the one module
    // that owns those nouns (#686) — not a second copy of them in the door.
    expect(requiredBranch, "the chooser does not label its entries with the kind's name")
      .toContain('factorKindName(k, t)');
    for (const [lang, dict] of [["en", en], ["ja", ja]] as const) {
      expect(dict.auth.factorPrompt, `${lang}: the deleted prompt came back — the buttons already name the kinds`).toBeUndefined();
      const tmpl: string = dict.auth.factorChoose;
      expect(tmpl, `${lang}: the chooser label does not take the kind`).toContain("{{kind}}");
      // …and the sentence around the noun names no kind of its own, which is the defect #686 measured
      // ("Set up Authenticator app" named one kind to somebody holding the other).
      expect(tmpl.toLowerCase(), `${lang}: the chooser label hard-codes a kind around the noun`)
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
