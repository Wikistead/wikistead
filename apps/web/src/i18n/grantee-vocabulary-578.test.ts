// #578 (review rejection ③): the two halves of "who gets this" name the same act.
//
// The group field said "or type a group name" — an "or" whose other half was the stacked select that
// the previous bounce removed, so the sentence pointed at nothing. Beside it the person field said
// "Search members…", which is what made a reader conclude the form takes people only. Same control,
// two vocabularies, one of them a leftover.
//
// Pinned as a RULE rather than as two strings: no placeholder anywhere may open with a dangling "or",
// and the grantee copy exists in both locales. A third surface that grows its own wording is caught by
// the same walk (the #544 lesson — an enumerated list waves the next one through).
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const flat = (o: Record<string, unknown>, p = ""): Array<[string, string]> =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]],
  );

describe("#578: the grantee vocabulary is one vocabulary", () => {
  it("no PLACEHOLDER opens with a dangling 'or' (the control it referred to is gone)", () => {
    // Placeholders only. A divider like "Or continue with" on the sign-in screen is a legitimate "or"
    // it continues the block of buttons above it. A placeholder has nothing above it to continue, so an
    // opening "or" there is always the residue of a control that used to sit beside the field.
    const dangling = [en, ja]
      .flatMap((loc) => flat(loc as unknown as Record<string, unknown>))
      .filter(([k]) => /placeholder/i.test(k))
      .filter(([, v]) => /^(or|または)\s/i.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(dangling).toEqual([]);
  });

  it("the grantee field's copy says it takes a member or a group, in both locales", () => {
    for (const [name, loc] of [["en", en], ["ja", ja]] as const) {
      const copy = flat(loc as unknown as Record<string, unknown>);
      const grantee = copy.find(([k]) => k === "common.granteeSearch")?.[1];
      expect(grantee, `${name} has the grantee placeholder`).toBeTruthy();
      expect(grantee!.length, `${name}'s grantee placeholder is not empty`).toBeGreaterThan(0);
      // it names both halves — the word for group appears in it
      expect(grantee!.toLowerCase(), `${name} names groups too`).toMatch(/group|グループ/);
    }
  });
});
