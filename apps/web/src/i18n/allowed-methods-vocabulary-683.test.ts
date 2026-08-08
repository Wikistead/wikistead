// #683 (ruling): the picker and its confirmation call the thing .
//
// The user's words: . Three strings carried the old phrasing — the
// picker's lead, the confirmation's heading, and the question that heading has to agree with — and they
// are changed together. Changing one splits the vocabulary in two, which is the shape this surface has
// produced repeatedly (#671 found one feature under three names; #653 and #673 found one kind under
// four).
//
// The replacement is not invented: mirrors the API key screen's , and the
// options being chosen (a passkey, an authenticator app) really are methods. 2 stays out of it
// — #671 removed that from the vocabulary.
//
// ⚠️ Pinned as the ABSENCE of the discarded words, per #671's shape and the ruling's own acceptance
// note. A pin asserting only the new wording stays green while an old string sits in a neighbouring key,
// which is how a second vocabulary survives a rename.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const flat = (o: Record<string, unknown>, p = ""): Array<[string, string]> =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]],
  );

/** The three the ruling named, which must all say the same thing. */
const TRIO = ["adminAuth.secondFactorKindsLead", "adminAuth.stanceKindsTitle", "adminAuth.stanceConfirmTail"];

describe("#683 (ruling): one name for the set of methods a workspace allows", () => {
  it("ja: the discarded phrasing is gone from every string", () => {
    // Swept over the WHOLE locale rather than the three keys, because the point of a vocabulary ruling
    // is that the old words do not survive somewhere nobody looked.
    const left = flat(ja).filter(([, v]) => /認める要素|要素として認める/.test(v));
    expect(left.map(([k]) => k), `the old phrasing survives:\n${left.map(([k, v]) => `${k}: ${v}`).join("\n")}`)
      .toEqual([]);
  });

  it("ja: and the three say it the same way", () => {
    const jf = Object.fromEntries(flat(ja));
    for (const k of TRIO) {
      expect(jf[k], `${k} does not use the ruled vocabulary :: ${jf[k]}`).toMatch(/許可する方式/);
    }
    // The heading is the question without the interrogative — the core of this ticket, unchanged by a
    // rename. Checked here too, because a vocabulary sweep that broke it would still pass above.
    expect(jf["adminAuth.stanceConfirmTail"]!.replace(/[?？]$/, ""))
      .toContain(jf["adminAuth.stanceKindsTitle"]!.replace(/する$/, ""));
  });

  it("en: the same three moved together, and left nothing behind", () => {
    const ef = Object.fromEntries(flat(en));
    for (const k of TRIO) {
      expect(ef[k], `${k} was left on the old wording :: ${ef[k]}`).toMatch(/allowed methods/i);
    }
    const left = flat(en).filter(([k, v]) => TRIO.includes(k) && /what counts|kinds count/i.test(v));
    expect(left.map(([k]) => k), "an English string kept the discarded phrasing").toEqual([]);
    expect(ef["adminAuth.stanceConfirmTail"]!.replace(/\?$/, ""))
      .toBe(ef["adminAuth.stanceKindsTitle"]!);
  });
});
