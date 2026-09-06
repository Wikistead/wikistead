// #1185: the toolbar's mode-switch button (`page.modeLive`/`page.modeSource`) and the account
// settings screen's own explanation of the SAME two modes (`account.displayModeHint`,
// `onboarding.changedHidMarkdownModes`) are independent translation entries for the same two words.
// French had them disagree: the button said "En direct" while the hint said the untranslated English
// "Live" — a reader who read the hint first would not recognize the button it was describing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LANGS } from "@wikistead/i18n-shared";

const LOCALES = resolve(import.meta.dirname, "locales");
const read = (lang: string) => JSON.parse(readFileSync(resolve(LOCALES, `${lang}.json`), "utf8")) as {
  page: { modeLive: string; modeSource: string };
  account: { displayModeHint: string };
  onboarding: { changedHidMarkdownModes: string };
};

describe("#1185: every language names Live/Source the SAME way in the button and in its own explanations", () => {
  it.each(LANGS)("%s: displayModeHint uses the button's own words for Live and Source", (lang) => {
    const json = read(lang);
    expect(json.account.displayModeHint, `${lang}: hint should say "${json.page.modeLive}", not some other word for Live`)
      .toContain(json.page.modeLive);
    expect(json.account.displayModeHint, `${lang}: hint should say "${json.page.modeSource}", not some other word for Source`)
      .toContain(json.page.modeSource);
  });

  it.each(LANGS)("%s: changedHidMarkdownModes uses the button's own words for Live and Source", (lang) => {
    const json = read(lang);
    expect(json.onboarding.changedHidMarkdownModes, `${lang}: should say "${json.page.modeLive}"`)
      .toContain(json.page.modeLive);
    expect(json.onboarding.changedHidMarkdownModes, `${lang}: should say "${json.page.modeSource}"`)
      .toContain(json.page.modeSource);
  });
});
