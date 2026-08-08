// #679 (ruling, 2026-08-09): the floor explanation stops after the instruction.
//
// — the third sentence was the REASON for the rule, and reading it changes nothing
// the admin does: two keys are needed either way. An instruction followed by an obvious justification.
//
// It is the third of the same shape in one day (#682 removed a domain note nobody could act on, and a
// how-to repeated at the moment it was already given). The test that would have caught all three is not
// "is this string absent" but the question behind it: does the sentence change the reader's next move?
// That is not machine-decidable, so what is pinned here is the ruling itself — the removed sentence
// must not come back — plus the two things the ruling said to KEEP, because a fix aimed at the first
// can quietly take them with it.
//
// ⚠️ Written as the ABSENCE of the old sentence, per the ruling's own acceptance note (#671's shape).
// A pin that only asserted the new wording would stay green with the old sentence still sitting one
// line below it — which is how two copies of a sentence survive a deletion.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const FLOOR = "adminAuth.passkeyFloorUnmet";
/** The confirmation shown as the stance is written — deliberately NOT touched by this ruling. */
const CONFIRM = "adminAuth.stancePasskeyWarning";

let i18n: I18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

describe("#679: the floor explanation says what to do, and stops", () => {
  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: the reason sentence is gone`, async () => {
      await i18n.changeLanguage(lng);
      const said = i18n.t(FLOOR, { count: 2 });
      // The removed claim, in both its halves — a rewording that kept the idea is the same defect.
      expect(said, `the floor explanation still argues why :: ${said}`)
        .not.toMatch(/書き出せ|事故|written down|single accident|locking the workspace/);
      // …and it still ends up being about the floor rather than about nothing.
      expect(said.length, "the explanation lost more than the reason").toBeGreaterThan(20);
    });

    it(`${lng}: what the ruling kept is still there`, async () => {
      await i18n.changeLanguage(lng);
      const said = i18n.t(FLOOR, { count: 2 });
      // The parenthetical IS the rule: without it "two passkeys" reads as "two admins", which is the
      // misreading the ruling named. Deleting the third sentence by truncating the string would take
      // this with it, and the case above would still pass.
      expect(said, `the shape of the floor is no longer stated :: ${said}`)
        .toMatch(/1 人でまとめて|複数人で分けて|on one admin|between several/);

      // And the confirmation's own warning is untouched — the ruling drew that line explicitly: at the
      // floor nothing can be done yet, at the confirmation the door is about to close.
      const confirm = i18n.t(CONFIRM);
      expect(confirm, `the confirmation lost its warning too :: ${confirm}`)
        .toMatch(/書き出せません|cannot be exported/);
    });
  }
});
