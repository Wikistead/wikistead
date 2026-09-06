// #1155 (ticket acceptance, parent #713/ADR-228): — ru and uk
// distinguish four cardinal-plural categories (one/few/many/other), unlike en/ja's two. A pin that only
// checks _one/_other exist (as the generic parity sweep in no-orphan-keys-645 does, by design, since not
// every language needs all five suffixes) would stay green even if ru/uk quietly collapsed back to the
// two-category shape — the exact regression this ticket exists to prevent.
//
// The boundary the ticket names explicitly: ru/uk count=21 resolves to the SAME category as count=1
// ("one" — n%10==1 && n%100!=11), not to "many" the way a naive "ends in 1 so it's few-ish" guess would
// assume. That is asserted here by checking 21's rendered string uses the same noun form as 1's, distinct
// from 2's (few) and 5's (many).
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import ru from "./locales/ru.json";
import uk from "./locales/uk.json";

let i18n: I18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { ru: { translation: ru }, uk: { translation: uk } },
    lng: "ru",
    fallbackLng: "ru",
    interpolation: { escapeValue: false },
  });
});

describe("#1155: ru/uk resolve all four CLDR cardinal categories, not just one/other", () => {
  for (const lng of ["ru", "uk"] as const) {
    it(`${lng}: members.groupRolesMark distinguishes one/few/many, and 21 matches 1's category`, async () => {
      await i18n.changeLanguage(lng);
      const at = (count: number) => i18n.t("members.groupRolesMark", { count });
      // compare the grammatical shape, not the literal string — "1" and "21" differ in the digits alone
      const shape = (s: string) => s.replace(/\d+/g, "#");
      const one = shape(at(1));
      const few = shape(at(2));
      const many = shape(at(5));
      const twentyOne = shape(at(21));
      // three genuinely different shapes — a language that only had _one/_other would render 2 and 5
      // identically, since i18next would fall back to _other for both.
      expect(new Set([one, few, many]).size, `${lng}: one/few/many collapsed to the same shape`).toBe(3);
      // and 21 is grammatically "one" again (n%10==1, n%100!=11), not a continuation of "many".
      expect(twentyOne, `${lng}: count=21 did not resolve to the same category as count=1`).toBe(one);
      expect(twentyOne).not.toBe(many);
    });

    it(`${lng}: adminAuth.stanceConfirmSweep's explicit _zero overrides the CLDR "many" category at 0`, async () => {
      await i18n.changeLanguage(lng);
      const zero = i18n.t("adminAuth.stanceConfirmSweep", { count: 0 });
      const many = i18n.t("adminAuth.stanceConfirmSweep", { count: 5 });
      // i18next's own zero-suffix special case (not a CLDR category) takes count=0 before CLDR's "many"
      // rule would otherwise apply to it — #672's lesson, restated here for a language that actually
      // reaches "many" through ordinary counting instead of only through zero.
      expect(zero, `${lng}: count=0 fell through to the "many" sentence instead of the explicit _zero one`)
        .not.toBe(many);
    });

    it(`${lng}: import.pagesCreated's few/many render distinct grammatical noun endings`, async () => {
      await i18n.changeLanguage(lng);
      const shape = (s: string) => s.replace(/\d+/g, "#");
      const few = shape(i18n.t("import.pagesCreated", { count: 3 }));
      const many = shape(i18n.t("import.pagesCreated", { count: 12 }));
      expect(few, `${lng}: few(3) and many(12) rendered the same grammatical shape`).not.toBe(many);
    });
  }
});
