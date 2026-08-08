// #685: the passkey floor is a number in one place, and the sentence about it says whatever that
// number is.
//
// It used to be spelled out: "at least two passkeys… two on one admin, or one each on two" in English
// and the same in Japanese. Three copies of one ruling — the constant plus two locales — and the two
// that a reader actually sees were the ones a change would not touch. Worse, the enumeration ("two on
// one, or one each on two") only parses AT two: at three it is simply wrong prose rather than a stale
// number, which is the kind of copy that survives review because nobody re-reads it at a new value.
//
// So this renders the sentence at several floors and asks that it carry the figure and stay sensible.
// It does NOT assert the floor is 2 — that claim has exactly one home, in the server test beside the
// constant (`floorFor`), so the ruling has one guard rather than a scattering of literals that all have
// to be found and edited together.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const KEY = "adminAuth.passkeyFloorUnmet";
let i18n: I18n;

beforeAll(async () => {
  // The app's own configuration (`./index.ts`) minus the React binding, the same way the neighbouring
  // i18n pins do it: a differently-configured instance would be measuring a library setup nobody ships.
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

describe("#685: the floor sentence follows the constant", () => {
  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: the number in the sentence is the number it was given`, async () => {
      await i18n.changeLanguage(lng);
      // Three values, none of them privileged. If the sentence were still a fixed string, all three
      // would be identical — and if it were pinned at the shipped floor, only that one would pass.
      for (const count of [2, 3, 5]) {
        const said = i18n.t(KEY, { count });
        expect(said, `the sentence does not carry the floor it was given (${count})`)
          .toMatch(new RegExp(`\\b${count}\\b`));
      }
      // …and the values really do produce different sentences, so "contains the number" cannot be
      // satisfied by a string that happens to contain every digit.
      const [two, three] = [i18n.t(KEY, { count: 2 }), i18n.t(KEY, { count: 3 })];
      expect(two, "the floor sentence is the same whatever the floor").not.toBe(three);

      // The old enumeration parsed only at two. A sentence that still says "one each on two" while
      // being handed three is worse than a stale figure: it reads as instructions.
      expect(three, "the sentence still describes the shape of a floor of two")
        .not.toMatch(/one each on two|2 人で 1 つずつ|1 人で 2 つ/);
      // A placeholder that never got substituted reads as a hole rather than a number.
      expect(two, "the interpolation did not run").not.toContain("{{");
    });
  }

  it("i18next actually reaches this key when a count is passed", async () => {
    // `count` is not an ordinary variable to i18next — it drives plural resolution, and a key with no
    // `_one` / `_other` siblings can resolve differently from the one written here. Measured rather
    // than assumed: the sentence is looked up BOTH ways and must be the same text.
    await i18n.changeLanguage("en");
    expect(i18n.t(KEY, { count: 2 })).toBe(i18n.t(KEY, { count: 2, context: undefined }));
    expect(i18n.t(KEY, { count: 2 }).length, "the key resolved to nothing").toBeGreaterThan(20);
  });
});
