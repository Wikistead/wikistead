// #947 (review bounce, 2026-08-27): the user asked "what is the Link button for, on a
// list of LINKED sign-in methods?" — the heading claimed the list held only already-linked rows, but
// ConnectionsLinkPanel.tsx's `rows` always includes unlinked oidc/platform connections too (the Link
// button is how you link one). The explainer sentence beside it was already correct and is left alone.
//
// Written as the ABSENCE of the old linked-only heading, not just the presence of new wording — a
// rewording that keeps the "already linked" claim (e.g. a synonym of "linked") would satisfy a
// positive-only pin while reproducing the same defect the user reported.
import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n as I18n } from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const TITLE = "account.connectionsTitle";
const EXPLAINER = "account.connectionsExplainer";

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

describe("#947 the connections heading must not claim the list is linked-only", () => {
  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: heading no longer reads as an already-linked list`, async () => {
      await i18n.changeLanguage(lng);
      const title = i18n.t(TITLE);
      // The exact old copy, hardcoded here (not derived from the locale file) so reverting either
      // side alone still fails this half of the pin.
      expect(title, `heading still reads as linked-only :: ${title}`)
        .not.toMatch(/^Linked sign-in methods$|^リンク済みのサインイン方法$/);
    });

    it(`${lng}: heading names linking as the action, matching every row it labels`, async () => {
      await i18n.changeLanguage(lng);
      const title = i18n.t(TITLE);
      if (lng === "en") expect(title, `heading no longer names linking :: ${title}`).toMatch(/link sign-in methods/i);
      else expect(title, `heading no longer names linking :: ${title}`).toMatch(/サインイン方法.*リンク|サインイン方法の連携/);
    });

    it(`${lng}: the explainer beside it is untouched`, async () => {
      await i18n.changeLanguage(lng);
      const explainer = i18n.t(EXPLAINER);
      expect(explainer, `explainer text changed :: ${explainer}`)
        .toMatch(/Add another way to sign in to this workspace|別のサインイン方法を追加します/);
    });
  }
});
