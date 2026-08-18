// @vitest-environment happy-dom
// #650 (review rejection twice, 2026-08-18): the re-authentication form said nothing about itself.
//
//
// Three defects, one screen: the fields carried a `placeholder` and an `aria-label` and no visible label
// (so the screen showed a box saying "123456" and a box saying , which reads as two boxes to
// fill when any ONE of three proofs is enough); the prompt never said "any one"; and the two buttons used
// two different verbs for the same act, so pressing the passkey one might have meant "unlock the form"
// rather than "make the codes".
//
// MEASURED ON THE RENDERED TEXT, not on the source. `textContent` is what a person reads: it contains a
// visible label and does NOT contain a placeholder attribute, so the exact regression that was reported
// twice — going back to placeholder-only — turns this red, while a source grep for `<label` would not.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));

/** the language the next render speaks — the real bundles, so the assertions are about shipped copy */
let lang = "en";
const lookup = (key: string) =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]);

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => lookup(k) ?? k, i18n: { language: lang } }) }));
vi.mock("../data/queries", () => ({
  useMyRecoveryCodes: () => ({}), useMintRecoveryCodes: () => ({}),
  useRecoveryReauthChallenge: () => ({}), useMyFactors: () => ({}),
}));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn() }));
vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const { RecoveryReauthForm } = await import("./RecoveryCodesPanel");

/** renders the form the way the panel does when somebody has both a code and a password */
const render = (l: string) => {
  lang = l;
  document.body.innerHTML = renderToStaticMarkup(createElement(RecoveryReauthForm, {
    proving: { code: "", password: "" }, onChange: () => {}, hasTotp: true, hasPasskey: true,
    busy: false, passkeyBusy: false, onSubmit: () => {}, onPasskey: () => {}, onCancel: () => {},
  }));
  return document.body;
};

describe("#650 ①: the form says what it wants", () => {
  it("each field's name is READ OFF THE SCREEN, not out of a placeholder", () => {
    for (const l of ["en", "ja"]) {
      const body = render(l);
      const text = body.textContent ?? "";
      expect(text, `${l}: the code field is named where a person can see it`)
        .toContain(bundles[l].account.recoveryReauthTotp);
      expect(text, `${l}: the password field is named where a person can see it`)
        .toContain(bundles[l].account.recoveryReauthPassword);
      // …and the name is TIED to its field, so it survives a re-layout and reaches a screen reader by
      // the same route it reaches an eye. A paragraph that happens to sit above an input is not a label.
      for (const testid of ["recovery-reauth-code", "recovery-reauth-password"]) {
        const field = body.querySelector(`[data-testid="${testid}"]`);
        expect(field, `${l}: ${testid} is on screen`).not.toBeNull();
        expect(field?.closest("label"), `${l}: ${testid} sits inside its label`).not.toBeNull();
      }
    }
  });

  it("the prompt says ANY ONE of these, because two stacked fields look like a checklist", () => {
    for (const l of ["en", "ja"]) {
      const prompt = bundles[l].account.recoveryReauthPrompt as string;
      expect(render(l).textContent ?? "", `${l}: the prompt is on screen`).toContain(prompt);
      expect(prompt, `${l}: the prompt says one is enough`).toMatch(l === "ja" ? /どれか 1 つ|いずれか 1 つ/ : /any one/i);
    }
  });

  it("both entrances say CREATE — three ways in, one destination", () => {
    // The reported confusion: beside. Different verbs on the
    // same act make the second button look like a step rather than the whole thing.
    for (const l of ["en", "ja"]) {
      const body = render(l);
      const submit = body.querySelector('[data-testid="recovery-reauth-submit"]')?.textContent ?? "";
      const passkey = body.querySelector('[data-testid="recovery-reauth-passkey"]')?.textContent ?? "";
      const verb = l === "ja" ? "作成" : "Create";
      expect(submit, `${l}: the submit button creates`).toContain(verb);
      expect(passkey, `${l}: the passkey button creates too, and does not merely "confirm"`).toContain(verb);
      expect(passkey, `${l}: it no longer promises only a check`).not.toMatch(/確認する|instead/i);
    }
  });
});

describe("#650 ①: nothing stands between the codes and the hand copying them", () => {
  ///(user): both notes under the one-time box are gone. The box already says "shown once,
  // copy it now"; the count is the ten lines being looked at; "each works once" is the explainer's first
  // sentence. Deleted BY KEY as well as by call, so the next person tidying translations cannot revive a
  // sentence whose only remaining trace is an orphan string.
  const src = readFileSync(resolve(import.meta.dirname, "RecoveryCodesPanel.tsx"), "utf8");

  it("the two notes are gone from the screen and from both bundles", () => {
    for (const key of ["recoveryStoreNote", "recoveryOneShotNote"]) {
      expect(src, `the panel no longer renders ${key}`).not.toContain(key);
      for (const l of ["en", "ja"]) {
        const hit = Object.keys(bundles[l].account).filter((k) => k.startsWith(key));
        expect(hit, `${l}: ${key} is deleted, plural suffixes and all :: ${hit.join(",")}`).toHaveLength(0);
      }
    }
  });

  it("the one thing worth keeping moved to where it is read BEFORE the codes exist", () => {
    // "not on the device that holds your second factor" is advice for the moment of deciding, not for
    // the moment of copying — so it lives in the explainer at the top of the panel.
    expect(bundles.en.account.recoveryExplainer, "en: says where NOT to keep them")
      .toMatch(/other than the device/i);
    expect(bundles.ja.account.recoveryExplainer, "ja: says where NOT to keep them")
      .toMatch(/第 2 要素が入っている端末とは別/);
    // and it does not resurrect the "phone" premise the ruling rejected: a second factor can be a passkey
    // in a laptop, and this product allows passkey-only workspaces (ADR-222).
    for (const l of ["en", "ja"]) {
      expect(bundles[l].account.recoveryExplainer, `${l}: no phone premise`).not.toMatch(/phone|スマートフォン/);
    }
  });
});
