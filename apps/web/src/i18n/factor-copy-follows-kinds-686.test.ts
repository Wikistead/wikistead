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
import { factorKindsPhrase, acceptedFactorKinds, factorKindName, ALL_FACTOR_KINDS } from "../settings/factor-kind";
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
        const phrase = factorKindsPhrase(accepted, t);

        // Both sentences are built from that phrase, so both are checked through it.
        const prompt = i18n.t("auth.factorEnrolPrompt", { kinds: phrase });
        const desc = i18n.t("account.factorsDesc", { kinds: phrase });

        for (const [where, said] of [["the interstitial", prompt], ["the account panel", desc]] as const) {
          for (const kind of ALL_FACTOR_KINDS) {
            const name = factorKindName(kind, t);
            const shouldName = accepted.includes(kind);
            expect(said.includes(name), `${where} ${shouldName ? "omits" : "names"} ${kind} :: ${said}`)
              .toBe(shouldName);
          }
          // A sentence with a hole in it is worse than one naming a kind too many.
          expect(said, `${where} left a placeholder`).not.toContain("{{");
        }
      });
    }
  }

  it("a narrowed stance really does say something different — or the mapping is vacuous", async () => {
    await i18n.changeLanguage("ja");
    const t = i18n.t.bind(i18n) as never;
    const say = (s: string | null) => i18n.t("auth.factorEnrolPrompt", { kinds: factorKindsPhrase(acceptedFactorKinds(s), t) });
    expect(say("passkey")).not.toBe(say("totp"));
    expect(say("any")).not.toBe(say("passkey"));
    // …and "no stance" reads as everything, matching what the interstitial's own `accepts` does with
    // an older server's response. A screen naming nothing would be worse than one naming both.
    expect(say(null)).toBe(say("any"));
  });

  it("an unknown kind is never called an authenticator app", async () => {
    // The default that #653was about: a third kind must not inherit one of today's names.
    await i18n.changeLanguage("ja");
    const t = i18n.t.bind(i18n) as never;
    expect(factorKindName("webauthn-v3", t)).toBe(factorKindName(null, t));
    expect(factorKindName("webauthn-v3", t)).not.toBe(factorKindName("totp", t));
  });
});
