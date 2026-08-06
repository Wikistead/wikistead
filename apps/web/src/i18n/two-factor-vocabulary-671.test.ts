// #671: one feature, one name — in each language.
//
// The user's words: 2 2FA . Measured across the locale files, one feature
// had three Japanese names (2 / 2 / 2 / 2 ) and two English ones (two-step
// sign-in / a second factor), spread across the account heading, the admin switch, the refusal a last
// admin meets and the sign-in interstitial. "2 " was the worst of them: a literal rendering of
// "second factor" that means nothing outside this product.
//
// Pinned as a RULE over EVERY string, not as a list of the seven that were wrong. The ticket asked for
// exactly this: a list would be silent the day an eighth surface is written, which is how the second
// vocabulary got in. So the walk looks for the DISCARDED words anywhere in either locale, and the day
// somebody writes 2 in a new key it fails there instead of in a review months later.
//
// NOT swept: `tenant.second_factor_required_on`, `member.factor_enrolled` and their kin. Those are wire
// identifiers — audit actions and webhook types — read by subscribers outside this repository and
// hash-chained into audit rows that are never rewritten. Renaming one to tidy a sentence breaks a
// consumer and leaves the ledger holding both names.
//
// They are not invisible, though: `AdminAuditTab` prints `r.action` verbatim, so a reader of the audit
// log meets `tenant.second_factor_required_on` as it is written. That is true of EVERY action in that
// table (`member.password_removed`, `space.deleted`, …) — the table has no vocabulary of its own, which
// is a bigger question than this ticket and belongs to whoever gives the audit log a reading surface.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const flat = (o: Record<string, unknown>, p = ""): Array<[string, string]> =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]],
  );

/** The names this feature is NOT called any more, per language. */
const DISCARDED = {
  // 2 is the direct translation; the family is the other vocabulary. Written with a
  // flexible space so "2" and " " are caught as well — a spacing difference is not a
  // different word, and a rule that missed it would wave through the same mistake retyped.
  ja: [/[2２]\s*要素目/, /[2２]\s*段階/, /二\s*段階/, /二\s*要素/],
  // "second step" too: the interstitial said "asks for a second step" while the switch beside it said
  // "a second factor", which is the same split in English.
  en: [/two[-\s]?step/i, /2[-\s]?step/i, /second step/i],
} as const;

/** …and what it IS called, so "nobody says it at all" cannot pass as consistency. */
const CANONICAL = { ja: /[2２]\s*要素認証/, en: /two-factor authentication/i } as const;

describe("#671: the second factor has one name in each language", () => {
  for (const [lang, loc] of [["ja", ja], ["en", en]] as const) {
    it(`${lang} uses none of the discarded names, anywhere`, () => {
      const offenders = flat(loc as unknown as Record<string, unknown>)
        .filter(([, v]) => DISCARDED[lang].some((re) => re.test(v)))
        .map(([k, v]) => `${k}: ${v}`);
      expect(offenders, `${lang} still carries another name for it`).toEqual([]);
    });

    it(`${lang} does name the feature`, () => {
      // The control. Deleting every mention would satisfy the case above and leave a product that
      // never says what the switch is for.
      const named = flat(loc as unknown as Record<string, unknown>).filter(([, v]) => CANONICAL[lang].test(v));
      expect(named.length, `${lang} says the canonical name somewhere`).toBeGreaterThan(0);
    });
  }

  it("the admin switch and the account heading say the same thing", () => {
    // The two surfaces the report contrasted: a tenant admin turning it on, and a member setting one
    // up. They are the two ends of one feature, and a reader who meets both should not have to work out
    // that they are the same.
    for (const [lang, loc] of [["ja", ja], ["en", en]] as const) {
      const copy = Object.fromEntries(flat(loc as unknown as Record<string, unknown>));
      expect(CANONICAL[lang].test(copy["account.factorsTitle"] ?? ""), `${lang} account heading`).toBe(true);
      expect(CANONICAL[lang].test(copy["adminAuth.secondFactorRequired"] ?? ""), `${lang} admin switch`).toBe(true);
    }
  });
});
