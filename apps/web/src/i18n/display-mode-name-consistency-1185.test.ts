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

// Owner's ruling (2026-09-06, #1185 review bounce): the two symptoms are distinct. The tests
// above fix cross-screen disagreement WITHIN a language; they pass even when a language leaves both
// words as the literal untranslated English "Live"/"Source" (ko/ru/uk did exactly that, and de/it/nl
// left one of the two words untranslated) — a fully-translated Korean or Russian screen with "Live" /
// "Source" sitting in Latin script reads as unfinished. Ruling: translate in every locale (WYSIWYG is
// the one exception, kept as the industry proper noun) — so this asserts the button's own words never
// equal the literal English ones, for every language but English itself.
describe("#1185: Live/Source are translated, not left as the English word, in every non-English language", () => {
  const nonEnglish = LANGS.filter((lang) => lang !== "en");
  it.each(nonEnglish)("%s: modeLive is not the literal English \"Live\"", (lang) => {
    expect(read(lang).page.modeLive, `${lang}: modeLive should be translated, not left as "Live"`).not.toBe("Live");
  });
  it.each(nonEnglish)("%s: modeSource is not the literal English \"Source\"", (lang) => {
    expect(read(lang).page.modeSource, `${lang}: modeSource should be translated, not left as "Source"`).not.toBe("Source");
  });
});
