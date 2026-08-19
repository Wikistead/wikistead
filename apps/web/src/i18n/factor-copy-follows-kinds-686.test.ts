// #686: a sentence that names a second-factor kind must get the name from what the workspace ACCEPTS.
//
// Three surfaces named a kind while the stance was in hand one line away
//
// the sign-in interstitial "set up an authenticator app" — beside a button offering only a passkey
// the account panel "a passkey or a six-digit code" — to a tenant that had stopped taking
// passkeys, one line above rows already marked "does not count"
// the row's mark correct since #672, which is what made the other two visible
//
// The interstitial is the heavy one: that reader is not signed in, so the sentence is the only
// instruction they have, and following it was impossible.
//
// ⚠️ Pinned as a MAPPING, per the ticket's own note: a test asserting "it says passkey" goes quiet for a
// `totp`-narrowed tenant, where the sentence would be wrong in the other direction. Every stance is
// walked, and each is required to name exactly the kinds it accepts and no others.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import {
  factorKindsPhrase, acceptedFactorKinds, factorKindName, factorKindPhrase, ALL_FACTOR_KINDS,
} from "../settings/factor-kind";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

/** Every stance the server can report, including the ones that mean "no narrowing". */
const STANCES = [null, "off", "any", "passkey", "totp"] as const;
let i18n: I18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
  });
});

describe("#686 族 A: the copy names what the workspace accepts", () => {
  for (const lng of ["en", "ja"] as const) {
    for (const stance of STANCES) {
      it(`${lng}: ${stance ?? "an older server"} — the sentences name exactly the accepted kinds`, async () => {
        await i18n.changeLanguage(lng);
        const t = i18n.t.bind(i18n) as never;
        const accepted = acceptedFactorKinds(stance);

        // #686 each sentence takes the noun SHAPE its own grammar needs — you set up an app,
        // you present a code from it. Built through the same call the screen makes, so a call site
        // asking for the wrong shape is measured here rather than read past.
        const said = [
          ["the interstitial", "setup" as const,
            i18n.t("auth.factorEnrolPrompt", { kinds: factorKindsPhrase(accepted, t, "setup") })],
          ["the account panel", "presented" as const,
            i18n.t("account.factorsDesc", { kinds: factorKindsPhrase(accepted, t, "presented") })],
          // ⚠️ #745 / ADR-240 deleted the door's sentence (owner ruling) because the chooser's
          // buttons name the kinds now. The PROPERTY this file holds — the screen names exactly the
          // kinds on offer, never one hard-coded kind — moved with it: the door's line is the two
          // button labels joined, which is what a member actually reads there.
          ["the sign-in door", "presented" as const,
            accepted.map((k) => i18n.t("auth.factorChoose", { kind: factorKindName(k, t) })).join(" ")],
        ] as const;

        for (const [where, shape, sentence] of said) {
          for (const kind of ALL_FACTOR_KINDS) {
            // ⚠️ A BUTTON says the noun; a sentence says the articled phrase ("a passkey"). Both are
            // the same claim about which kinds the screen names, so the door is compared against the
            // bare name — asking a button for an article would fail on correct copy.
            const noun = where === "the sign-in door" ? factorKindName(kind, t) : factorKindPhrase(kind, t, shape);
            const shouldName = accepted.includes(kind);
            expect(sentence.includes(noun), `${where} ${shouldName ? "omits" : "names"} ${kind} :: ${sentence}`)
              .toBe(shouldName);
          }
          // A sentence with a hole in it is worse than one naming a kind too many.
          expect(sentence, `${where} left a placeholder`).not.toContain("{{");
        }
      });
    }
  }

  it("a narrowed stance really does say something different — or the mapping is vacuous", async () => {
    await i18n.changeLanguage("ja");
    const t = i18n.t.bind(i18n) as never;
    const say = (s: string | null) =>
      i18n.t("auth.factorEnrolPrompt", { kinds: factorKindsPhrase(acceptedFactorKinds(s), t, "setup") });
    expect(say("passkey")).not.toBe(say("totp"));
    expect(say("any")).not.toBe(say("passkey"));
    // …and "no stance" reads as everything, matching what the interstitial's own `accepts` does with
    // an older server's response. A screen naming nothing would be worse than one naming both.
    expect(say(null)).toBe(say("any"));
  });

  it("an unknown kind is never called an authenticator app — in EITHER shape", async () => {
    // The default that #653 was about: a third kind must not inherit one of today's names. It
    // now has two chances to inherit one, and the second (\u201ca code from your authenticator app\u201d) is the
    // more misleading — it tells somebody to type digits at a key they tap.
    for (const lng of ["en", "ja"] as const) {
      await i18n.changeLanguage(lng);
      const t = i18n.t.bind(i18n) as never;
      expect(factorKindName("webauthn-v3", t)).toBe(factorKindName(null, t));
      expect(factorKindName("webauthn-v3", t)).not.toBe(factorKindName("totp", t));
      for (const shape of ["setup", "presented"] as const) {
        expect(factorKindPhrase("webauthn-v3", t, shape)).toBe(factorKindPhrase(null, t, shape));
        expect(factorKindPhrase("webauthn-v3", t, shape)).not.toBe(factorKindPhrase("totp", t, shape));
      }
    }
  });

  it("the two shapes are genuinely different nouns — one shared function would be vacuous", async () => {
    // ⚠️ THE CONTROL for. Wiring both sentence types back through one noun is exactly the state
    // being fixed, and every mapping assertion above would still pass: they only ask that the sentence
    // names the accepted kinds. What must differ is WHAT it calls them.
    for (const lng of ["en", "ja"] as const) {
      await i18n.changeLanguage(lng);
      const t = i18n.t.bind(i18n) as never;
      expect(factorKindPhrase("totp", t, "setup"),
        `${lng}: what you install and what you present are the same words`)
        .not.toBe(factorKindPhrase("totp", t, "presented"));
      // …and the LABEL is a third thing: it belongs on a row, not inside a sentence. In English the
      // article is what separates them; in Japanese the presented form carries \u300c\u306e\u30b3\u30fc\u30c9\u300d.
      expect(factorKindPhrase("totp", t, "presented"), `${lng}: the label leaked into running prose`)
        .not.toBe(factorKindName("totp", t));
    }
  });

  it("no sentence carries a bare label — the article/particle comes from the locale", async () => {
    // The English defect measured: \u201cSet up Authenticator app to continue.\u201d The mid-sentence
    // capital is the tell, and it is what a label looks like when it is dropped into prose.
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n) as never;
    for (const [key, shape] of [
      // The door's sentence is gone (#745); its buttons are checked for the same defect below, and a
      // button label is a label by design — the rule here is about labels dropped into PROSE.
      ["auth.factorEnrolPrompt", "setup"], ["account.factorsDesc", "presented"],
    ] as const) {
      const sentence = i18n.t(key, { kinds: factorKindsPhrase(["totp"], t, shape) });
      expect(sentence, `${key} still drops the label into prose`).not.toContain(factorKindName("totp", t));
      // The nouns are lower-case and articled; nothing in the code adds the article (a rule this
      // repository must not learn, since the next locale would have to defeat it).
      expect(factorKindPhrase("totp", t, shape), "the English noun lost its article").toMatch(/^(a|an) /);
    }
  });
});
