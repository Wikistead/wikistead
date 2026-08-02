// #585: the UI does not use a dash as punctuation.
//
// "——" — the em dash was doing the work of a full stop or a colon in
// a hundred strings across both locales, and in Japanese it reads worse than in English. The strings
// were rewritten; this keeps them rewritten, which a one-off cleanup cannot do on its own (this repo
// has watched three hand-written copy pins go stale in a week for exactly that reason).
//
// It is DISCOVERY-based: it walks whatever is in the locale files rather than holding a list of the
// hundred strings that were fixed, so a NEW string with a dash fails on the commit that adds it.
//
// The other half of #585 — deleting the "here is why the mechanism works this way" sentences — is not
// pinned, and cannot be: no rule distinguishes a sentence that explains a consequence (keep) from one
// that explains an implementation (drop). That half is enforced by review, and saying so here is
// better than a regex that pretends otherwise.
//
// A range keeps its en dash (`H1–H3`, `0–1`): it is not punctuation between clauses, and replacing it
// would make the copy worse. So the rule is "no em dash anywhere, and no SPACED dash of any kind",
// which is exactly the shape that was being used as a separator.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

type Tree = { [k: string]: string | Tree };

const flatten = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [[key, v] as [string, string]] : flatten(v, key);
  });

const SEPARATOR = /—|\s[–-]\s/; // any em dash; en dash or hyphen used as a spaced separator

const offenders = (tree: Tree) =>
  flatten(tree)
    .filter(([, v]) => SEPARATOR.test(v))
    .map(([k, v]) => `${k}: ${v}`);

describe("#585: no dash punctuation in UI copy", () => {
  it("English", () => {
    expect(offenders(en as Tree), "use a full stop, a colon, or a comma").toEqual([]);
  });

  it("Japanese", () => {
    expect(offenders(ja as Tree), "use 。 or ： instead").toEqual([]);
  });

  it("keeps ranges, which are not punctuation", () => {
    // guard the guard: the rule must not fire on the two legitimate en dashes in the files
    expect(SEPARATOR.test("H1–H3")).toBe(false);
    expect(SEPARATOR.test("this fraction of the published text (0–1, e.g. 0.2)")).toBe(false);
    // ...and must fire on every shape that was actually in there
    expect(SEPARATOR.test("On — pages marked public")).toBe(true);
    expect(SEPARATOR.test("Conferred by a group mapping - remove it below")).toBe(true);
    expect(SEPARATOR.test("割り当ては上の選択肢から行います——ロールの権限は")).toBe(true);
  });

  it("both locales carry the same keys, so a rewrite cannot land in one and not the other", () => {
    // i18next plural forms are per-language: Japanese has ONE form, so `foo_one` legitimately exists
    // only in English (`delete.backlinkWarning_one` is the live example). Compare the singular-stripped
    // sets so the parity check stays about MISSING TRANSLATIONS and not about grammar.
    const keysOf = (t: Tree) => [...new Set(flatten(t).map(([k]) => k.replace(/_(one|other)$/, "")))].sort();
    const [e, j] = [keysOf(en as Tree), keysOf(ja as Tree)];
    expect(e.filter((k) => !j.includes(k)), "English keys with no Japanese").toEqual([]);
    expect(j.filter((k) => !e.includes(k)), "Japanese keys with no English").toEqual([]);
  });
});
