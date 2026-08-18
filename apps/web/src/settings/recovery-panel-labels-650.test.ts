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

const { RecoveryReauthForm, proofsHeld, initialMethod } = await import("./RecoveryCodesPanel");

type Method = "totp" | "passkey" | "password";

/**
 * Render the form as the panel would for a member holding `methods`, standing at `method`
 * (null = still choosing).
 */
const render = (l: string, methods: Method[], method: Method | null) => {
  lang = l;
  document.body.innerHTML = renderToStaticMarkup(createElement(RecoveryReauthForm, {
    method, methods, proving: { code: "", password: "" }, onChange: () => {}, onPick: () => {},
    busy: false, passkeyBusy: false, onSubmit: () => {}, onPasskey: () => {}, onCancel: () => {},
  }));
  return document.body;
};

const ALL: Method[] = ["totp", "passkey", "password"];

describe("#650 ①: the form says what it wants", () => {
  it("each field's name is READ OFF THE SCREEN, not out of a placeholder", () => {
    for (const l of ["en", "ja"]) {
      for (const [method, key, testid] of [
        ["totp", "recoveryReauthTotp", "recovery-reauth-code"],
        ["password", "recoveryReauthPassword", "recovery-reauth-password"],
      ] as const) {
        const body = render(l, ALL, method);
        expect(body.textContent ?? "", `${l}: ${method} is named where a person can see it`)
          .toContain(bundles[l].account[key]);
        // …and the name is TIED to its field, so it survives a re-layout and reaches a screen reader by
        // the same route it reaches an eye. A paragraph that happens to sit above an input is not a label.
        const field = body.querySelector(`[data-testid="${testid}"]`);
        expect(field, `${l}: ${testid} is on screen`).not.toBeNull();
        expect(field?.closest("label"), `${l}: ${testid} sits inside its label`).not.toBeNull();
      }
    }
  });

  it("both entrances say CREATE — three ways in, one destination", () => {
    // The reported confusion: beside. Different verbs on the
    // same act make the second button look like a step rather than the whole thing.
    for (const l of ["en", "ja"]) {
      const verb = l === "ja" ? "作成" : "Create";
      const submit = render(l, ALL, "totp").querySelector('[data-testid="recovery-reauth-submit"]')?.textContent ?? "";
      const passkey = render(l, ALL, "passkey").querySelector('[data-testid="recovery-reauth-passkey"]')?.textContent ?? "";
      expect(submit, `${l}: the submit button creates`).toContain(verb);
      expect(passkey, `${l}: the passkey button creates too, and does not merely "confirm"`).toContain(verb);
      expect(passkey, `${l}: it no longer promises only a check`).not.toMatch(/確認する|instead/i);
    }
  });
});

// — two of the three did, and the password box did not.
//
// The ruling replaced the whole shape: pick a method, then prove. So the assertions are about WHICH
// controls exist for a given member, which is the thing that was wrong, rather than about the sentence
// that used to apologise for the layout.
describe("#650 the form offers what this member holds, and nothing else", () => {
  /** every control that names a method, whichever stage the form is at */
  const offered = (body: HTMLElement) => ({
    chooser: ALL.filter((m) => body.querySelector(`[data-testid="recovery-reauth-choose-${m}"]`)),
    code: !!body.querySelector('[data-testid="recovery-reauth-code"]'),
    password: !!body.querySelector('[data-testid="recovery-reauth-password"]'),
    passkey: !!body.querySelector('[data-testid="recovery-reauth-passkey"]'),
  });

  it("a member with no password is never shown a password box", () => {
    // The reported case: somebody who signs in through an IdP, or whose password entrance an admin
    // removed — which THIS feature is wired to do (a password removal revokes the codes with it).
    for (const l of ["en", "ja"]) {
      const chooser = offered(render(l, ["totp", "passkey"], null));
      expect(chooser.chooser, `${l}: only the two proofs they hold are offered`).toEqual(["totp", "passkey"]);
      expect(chooser.password, `${l}: no password box at the chooser`).toBe(false);
      // and not through the other stage either
      expect(offered(render(l, ["totp", "passkey"], "totp")).password, `${l}: nor once a method is picked`).toBe(false);
    }
  });

  it("a member with only a password is taken straight to it, with no menu of one", () => {
    // Ruling ①: a chooser with a single entry charges a keystroke for a decision that has one answer.
    const body = render("en", ["password"], "password");
    expect(body.querySelector('[data-testid="recovery-reauth-choices"]'), "no chooser at all").toBeNull();
    expect(offered(body).password, "the password field is right there").toBe(true);
    expect(offered(body).code, "and nothing they cannot use").toBe(false);
    expect(offered(body).passkey, "…including the passkey button").toBe(false);
    // …and no way back, because there is nowhere to go back TO.
    expect(body.querySelector('[data-testid="recovery-reauth-back"]'), "nothing to return to").toBeNull();
  });

  it("a member with several proofs picks one, and can change their mind", () => {
    const chooser = render("en", ALL, null);
    expect(offered(chooser).chooser, "all three are offered").toEqual(ALL);
    // Nothing to type at the chooser: the reader's job here is to choose, and a box beside the choices
    // is the checklist shape all over again.
    expect(offered(chooser).code, "no code box while choosing").toBe(false);
    expect(offered(chooser).password, "no password box while choosing").toBe(false);

    const picked = render("en", ALL, "totp");
    expect(offered(picked).code, "the chosen proof's input is shown").toBe(true);
    expect(offered(picked).password, "and only that one").toBe(false);
    expect(picked.querySelector('[data-testid="recovery-reauth-back"]'), "a way back to the others").not.toBeNull();
  });

  it("the prompt no longer explains the layout, because the layout says it", () => {
    // The old prompt ended with "any one of these is enough" — a sentence whose only job was to
    // compensate for two fields stacked above two buttons. Ruled out with the shape it described.
    for (const l of ["en", "ja"]) {
      const prompt = bundles[l].account.recoveryReauthPrompt as string;
      expect(render(l, ALL, null).textContent ?? "", `${l}: the prompt is on screen`).toContain(prompt);
      expect(prompt, `${l}: it no longer says "any one of these"`).not.toMatch(l === "ja" ? /どれか 1 つ|いずれか 1 つ/ : /any one/i);
    }
  });
});

describe("#650 which proofs a member is credited with", () => {
  // The list the form is handed. Tested as a function because the DEFECT was in the derivation, not in
  // the drawing: the factor halves were derived correctly and came and went with the factors, while the
  // password was simply drawn. Dropping `hasPassword` from this function turns the first case below red.
  const totp = { kind: "totp", confirmedAt: "2026-01-01T00:00:00Z" };
  const passkey = { kind: "passkey", confirmedAt: "2026-01-01T00:00:00Z" };

  it("a password is credited ONLY when the server said there is one", () => {
    expect(proofsHeld({ factors: [totp], hasPassword: false, webauthn: true }),
      "no password entrance, no password box").toEqual(["totp"]);
    expect(proofsHeld({ factors: [totp], hasPassword: true, webauthn: true }),
      "…and it appears when there is one").toEqual(["totp", "password"]);
  });

  it("an unconfirmed factor is not a proof", () => {
    // An abandoned enrolment is a row, not a factor: offering its box would ask for a code from a
    // secret the member never finished installing.
    expect(proofsHeld({ factors: [{ kind: "totp", confirmedAt: null }], hasPassword: true, webauthn: true }))
      .toEqual(["password"]);
  });

  it("one proof means no chooser: the member starts AT it", () => {
    // Ruling ①. Measured separately because the form is handed a method and draws it — a regression
    // that stopped skipping the chooser would leave every rendering assertion above perfectly green.
    expect(initialMethod(["password"]), "straight to the only thing they can do").toBe("password");
    expect(initialMethod(["totp", "password"]), "two proofs is a choice").toBeNull();
    expect(initialMethod([]), "and nothing to start at when there is nothing").toBeNull();
  });

  it("a key is not a proof in a window that cannot do WebAuthn", () => {
    expect(proofsHeld({ factors: [passkey], hasPassword: false, webauthn: false }),
      "nothing on offer rather than a prompt that cannot open").toEqual([]);
    expect(proofsHeld({ factors: [passkey], hasPassword: false, webauthn: true })).toEqual(["passkey"]);
  });

  it("…and when that leaves nothing, the panel says so instead of opening an empty chooser", () => {
    // The case the line above produces: a key-only member in a window with no WebAuthn and no password
    // entrance. They HAVE something to recover, so the mint button shows — and without this the form
    // opens with no way to prove anything in it.
    const src = readFileSync(resolve(import.meta.dirname, "RecoveryCodesPanel.tsx"), "utf8");
    expect(src, "the empty case is answered, not fallen through").toContain("recovery-no-proof");
    for (const l of ["en", "ja"]) {
      expect(bundles[l].account.recoveryNoProof, `${l}: and it says what to do next`).toBeTruthy();
    }
  });
});

describe("#650 ①: nothing stands between the codes and the hand copying them", () => {
  // / (user): both notes under the one-time box are gone. The box already says "shown once,
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
