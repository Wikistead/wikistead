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

// RE-AIMED by #586: the BASELINE BOX is gone. It existed to explain in prose an inclusion the screen
// would not show ("manager and moderator can always comment"), and the ruling replaced explanation with
// display — the role badges now list what they confer, measured against the model. So the pair this
// compared no longer exists as a pair. What survives is the half that is still on screen: the effective
// summary, which must keep naming the built-ins as proper nouns (#582's ruling is untouched).
describe("#582: the comment panel names built-in roles as proper nouns", () => {
  for (const [name, dict] of Object.entries(LOCALES)) {
    it(`${name}: the effective summary names the roles by their own names`, () => {
      const summary = dict.spaceMembers.commentSummaryEditors!;
      for (const noun of NOUNS) {
        expect(summary.toLowerCase(), `the summary names ${noun}`).toContain(noun);
      }
    });

    it(`${name}: it does not fall back to a translated role name`, () => {
      // the exact words that were on screen before this fix, so a revert is named rather than merely
      // "different"
      for (const word of ["管理者", "モデレーター", "managers,", "moderators"]) {
        expect(dict.spaceMembers.commentSummaryEditors!, `the summary uses the proper noun, not "${word}"`).not.toContain(word);
      }
    });

    it(`${name}: and the prose that explained the inclusion is gone (the badges say it now)`, () => {
      expect(dict.spaceMembers.commentBaselineEditors, "removed by #586 — do not reintroduce").toBeUndefined();
    });
  }
});
