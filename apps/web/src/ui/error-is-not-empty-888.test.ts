// #888: a list that could not be fetched is not an empty list.
//
// THE DEFECT: react-query's `isLoading` goes false the moment a request settles, success or not, and
// `data` stays undefined on failure. `!isLoading && (data?.length ?? 0) === 0` therefore renders the
// empty state for a fetch that FAILED. #500 found this on the page tree — a space with pages looked
// like a space with none — and the ruling was "error ≠ empty". Six surfaces still had the shape.
//
// ⚠️ TWO OF THEM ANSWER A QUESTION ABOUT ACCESS. A share-link list and a page's permissions list that
// say "nobody" because a request failed tell an admin doing a review that the page is closed, when
// nothing of the sort was established. That is the reason this is a bug and not a polish item.
//
// This walks the tree rather than listing the six: the next surface written in this shape has to be
// caught by a test nobody remembers to update. A walk that matches nothing is a red.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { if (entry !== "node_modules") walk(p, out); }
    else if ((p.endsWith(".tsx") || p.endsWith(".ts")) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

// `(x.data?.length ?? 0) === 0`, `!x.data?.length`, `x.data?.length === 0` — the ways this tree spells
// "the list is empty" off a react-query result. The capture is the query variable, so the same file
// can hold one guarded list and one unguarded one and still be judged per list.
const EMPTY_STATE = /\((\w+)\.data\?\.length \?\? 0\) === 0|!\s*(\w+)\.data\?\.length\b|(\w+)\.data\?\.length === 0/g;

type Site = { file: string; query: string; guarded: boolean };

const sites: Site[] = [];
for (const file of walk(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(EMPTY_STATE)) {
    const query = (m[1] ?? m[2] ?? m[3])!;
    // Guarded = this surface asks THIS query whether it failed. Anywhere in the file is enough: the
    // check may sit in a sibling branch, and a false positive here would only weaken the test, not
    // hide a defect — the defect is a query nobody asks at all.
    const guarded = new RegExp(`\\b${query}\\.isError\\b`).test(src);
    sites.push({ file: file.slice(SRC_ROOT.length + 1), query, guarded });
  }
}

describe("#888 a failed fetch is not an empty list", () => {
  it("finds the empty-state surfaces at all", () => {
    // The guard on the walk. If the spelling of an empty state changes, this reddens instead of
    // letting every case below pass on an empty list of cases.
    expect(sites.length, `no empty-state surfaces found under ${SRC_ROOT}`).toBeGreaterThanOrEqual(6);
  });

  it.each(sites.map((s) => [`${s.file} (${s.query})`, s] as const))(
    "%s asks whether the fetch failed before saying it is empty",
    (_label, site) => {
      expect(site.guarded, `${site.query} in ${site.file} renders its empty state for a failed fetch`).toBe(true);
    },
  );

  it("says it in both locales, and the Japanese is not the English", () => {
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    const ja = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const key of ["loadFailed", "loadRetry"]) {
      expect(en.common?.[key], `en is missing common.${key}`).toBeTruthy();
      expect(ja.common?.[key], `ja is missing common.${key}`).toBeTruthy();
      expect(ja.common![key], `ja.common.${key} is still the English string`).not.toBe(en.common![key]);
    }
  });

  it("names no resource, so it cannot leak the existence of one (#227)", () => {
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const word of ["page", "space", "link", "member", "permission"]) {
      expect(en.common!.loadFailed.toLowerCase(), `the sentence must not name a ${word}`).not.toContain(word);
    }
  });

  it("always offers the way back — a dead end in kinder words is still a dead end", () => {
    const view = readFileSync(resolve(SRC_ROOT, "ui/LoadFailed.tsx"), "utf8");
    expect(view).toContain("common.loadFailed");
    expect(view).toContain("common.loadRetry");
    expect(view).toMatch(/-retry[\s\S]{0,120}onClick=\{onRetry\}/);
  });
});
