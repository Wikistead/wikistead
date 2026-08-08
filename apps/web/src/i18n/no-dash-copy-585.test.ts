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
// SCOPE, widened after the review found two it could not see (#585): the locale files are
// not the only place UI text lives. A pending-invite row read `{email} — {role}` straight out of JSX,
// and the macro registry built `<code>1.0.0</code> — date — sha …` as HTML. A pin that reads like
// "no dashes in the UI" while checking one directory is worse than one that says what it checks — so
// this now walks apps/web/src as well.
//
// Source text is not locale text, and the difference is handled explicitly rather than by hoping
// comments are stripped (this file is FULL of dashes, and so is every file it reads), the ASCII
// hyphen is not searched for at all in source (it is subtraction, in 200-odd places), and a dash that
// belongs — a developer-facing throw, a policy table's own rationale — is kept with a `// dash-ok:`
// note on the line above. The annotation is the same shape as the repo's `// fga-read-ok:` markers
// the exception has to be written down, and it says why.
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

const WEB_SRC = resolve(import.meta.dirname, "..");

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p);
    }
  };
  walk(WEB_SRC);
  return out;
};

/** Comments carry dashes freely — this file included — so they are removed before the search. */
const withoutComments = (src: string): string[] =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""));

/** In SOURCE only the real dashes are searched for: the ASCII hyphen is subtraction, ~200 times. */
const SOURCE_DASH = /[—–]/;

const sourceOffenders = (): string[] => {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    const raw = readFileSync(file, "utf8").split("\n");
    withoutComments(readFileSync(file, "utf8")).forEach((line, i) => {
      if (!SOURCE_DASH.test(line)) return;
      // an exception is declared on the line above, and has to say why
      if (/\/\/\s*dash-ok:/.test(raw[i - 1] ?? "")) return;
      found.push(`${file.slice(WEB_SRC.length + 1)}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
};

describe("#585: no dash punctuation in UI copy", () => {
  it("English", () => {
    expect(offenders(en as Tree), "use a full stop, a colon, or a comma").toEqual([]);
  });

  it("Japanese", () => {
    expect(offenders(ja as Tree), "use 。 or ： instead").toEqual([]);
  });

  it("source files outside the locales", () => {
    expect(sourceOffenders(), "UI text in JSX or generated HTML — or mark it `// dash-ok:` with a reason").toEqual([]);
  });

  it("the source scan is looking at something (guard against a vacuous pass)", () => {
    expect(sourceFiles().length, "walked apps/web/src").toBeGreaterThan(100);
    // and it must not be blind to the two shapes the review found
    const raw = ["const x = <li>{a} — {b}</li>;", "  `<li>${v} — ${d}</li>`,"];
    for (const line of raw) expect(SOURCE_DASH.test(withoutComments(line)[0]!), line).toBe(true);
    // ...while a comment and an arithmetic hyphen are invisible to it
    expect(SOURCE_DASH.test(withoutComments("// a comment — with a dash")[0]!)).toBe(false);
    expect(SOURCE_DASH.test(withoutComments("const n = a.length - 1;")[0]!)).toBe(false);
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
    // only in English. `delete.backlinkWarning_one` is the live example — and it only became one in
    // #668; when this comment was written the key it named did not exist in either locale, which is
    // exactly the hole #662's scan went looking for. Compare the singular-stripped sets so the parity
    // check stays about MISSING TRANSLATIONS and not about grammar.
    // #672: `_zero` joins them. It is not a plural CATEGORY — i18next looks it up as a special case
    // before plural resolution — so a language whose only form is `other` carries it too, and a parity
    // check that did not strip it would demand a `_zero` in every language that has an `_other`.
    const keysOf = (t: Tree) => [...new Set(flatten(t).map(([k]) => k.replace(/_(one|other|zero)$/, "")))].sort();
    const [e, j] = [keysOf(en as Tree), keysOf(ja as Tree)];
    expect(e.filter((k) => !j.includes(k)), "English keys with no Japanese").toEqual([]);
    expect(j.filter((k) => !e.includes(k)), "Japanese keys with no English").toEqual([]);
  });
});
