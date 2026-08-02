// #582 the comment panel says the same thing twice, in two vocabularies.
//
// Measured on a real screen, two lines apart, in Japanese
//
// baseline box : manager moderator … ← proper nouns (already done)
// summary line : … ← still translated
//
// #582's ruling is that a built-in role name is a proper noun everywhere. The baseline box had been
// converted and the effective-summary line had not, so one panel named the same two roles two ways.
// That is the class #553 was bounced for four times: a panel contradicting itself.
//
// The pin is written so that fixing ONE line cannot satisfy it — it compares the two strings against
// each other. A pin that only checked the summary would go green while the box drifted the other way.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const LOCALES = { en, ja } as Record<string, { spaceMembers: Record<string, string> }>;
// The two built-ins this panel names. They are proper nouns (#582), so they appear verbatim.
const NOUNS = ["manager", "moderator"];

describe("#582: one panel, one vocabulary for the built-in roles", () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}: the baseline box and the effective summary name the roles the same way`, () => {
      const baseline = dict.spaceMembers.commentBaselineEditors!;
      const summary = dict.spaceMembers.commentSummaryEditors!;
      for (const noun of NOUNS) {
        expect(baseline.toLowerCase(), `the baseline box names ${noun}`).toContain(noun);
        expect(summary.toLowerCase(), `and so does the summary, in the same word`).toContain(noun);
      }
    });

    it(`${name}: neither line falls back to a translated role name`, () => {
      // the exact words that were on screen before this fix, so a revert is named rather than merely
      // "different"
      const translated = ["管理者", "モデレーター", "managers,", "moderators"];
      for (const key of ["commentBaselineEditors", "commentSummaryEditors"]) {
        for (const word of translated) {
          expect(dict.spaceMembers[key]!, `${key} uses the proper noun, not "${word}"`).not.toContain(word);
        }
      }
    });
  }
});
