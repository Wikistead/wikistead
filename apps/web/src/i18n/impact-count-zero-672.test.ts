// #672 (review rejection ②): a sentence about nobody.
//
// Narrowing the stance asks a question with the number in it, and at zero it read
//
// en "0 members cannot satisfy this and will be signed out now, and asked to enrol next time…"
//
// 0 followed by , pointing at people who do not exist — and the same sentence
// promising to sign them out. One `{{count}}` string cannot say 0, 1 and N.
//
// ⚠️ Japanese having no plural is not a reason to skip the branch, which is the reading that produced
// this: `_zero` is a SPECIAL CASE i18next looks up before plural resolution, not a plural category, so
// a language whose only form is `other` still gets it. Pinned by RENDERING rather than by asserting the
// key exists — the key existing says nothing about whether i18next reaches it in this locale, which is
// the whole of the doubt.
//
// The n=1 and n=2 cases are the control. Without them a "fix" that answered the zero sentence for every
// count would pass, and the number — the reason the question is asked at all — would vanish.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const KEY = "adminAuth.stanceConfirmSweep";
let i18n: I18n;

beforeAll(async () => {
  // The app's own configuration (`./index.ts`), minus the React binding and the browser detection it
  // does at import time. Same resources, same fallback — a pin against a differently-configured
  // instance would be measuring a library setup nobody ships.
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

describe("#672 ②: the sweep sentence at zero", () => {
  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: says nobody is affected, and does not promise to sign anybody out`, async () => {
      await i18n.changeLanguage(lng);
      const zero = i18n.t(KEY, { count: 0 });

      // It resolved to something of its own — not to the `_other` string with a 0 substituted in, which
      // is what happens when i18next never reaches `_zero`. Compared against that suffix directly
      // asking for the same key with a different option falls back to the SAME resolution and would
      // have passed while `_zero` was ignored.
      expect(zero, "zero fell through to the counted sentence")
        .not.toBe(i18n.t(`${KEY}_other`, { count: 0 }));
      expect(zero).not.toMatch(/\b0\b|０/);
      // The two halves the report named: a group referred to, and a sign-out promised about them.
      expect(zero, "the sentence still points at people who do not exist").not.toMatch(/その人たち|they|them/i);
      expect(zero, "nobody is being signed out, so the sentence must not say so")
        .not.toMatch(/サインアウト|signed out/i);
      expect(zero.length, "zero has a sentence of its own").toBeGreaterThan(4);
    });

    it(`${lng}: one and many still carry the number`, async () => {
      await i18n.changeLanguage(lng);
      // The control. A zero-shaped answer for every count would satisfy the case above.
      const one = i18n.t(KEY, { count: 1 });
      const many = i18n.t(KEY, { count: 7 });
      expect(one, "the count vanished at 1").toMatch(/1|一|One|one/);
      expect(many).toMatch(/7/);
      expect(many, "the sign-out is what the question is about").toMatch(/サインアウト|signed out/i);
      expect(one).not.toBe(i18n.t(KEY, { count: 0 }));
    });
  }
});
