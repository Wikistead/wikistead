// #740 (user, at the recovery-codes screen): UI .
//
// The screen that started it showed a box containing `123456` and a box containing ``, and
// the reader could not tell what either wanted. That screen is fixed (#650); this walk is about the
// rest of the product, and about the next one somebody writes.
//
// THE RULE IS ABOUT THE PLACEHOLDER'S VALUE, not about a list of files.
//
// A placeholder that NAMES its field ("Search pages…", "Filter members…") is the industry idiom and
// needs no label — a magnifying glass and the words are the whole control. A placeholder that shows
// a SAMPLE VALUE (`123456`, `my-team`, `email@example.com`, `YYYY-MM-DD`) names nothing: it shows
// what an answer looks like, which is useful, and it disappears at the first keystroke, which is
// exactly when somebody stops to check what they are filling in. Those fields need a label that
// stays.
//
// So the walk classifies by the string a reader would see, and only then asks for a label. That is
// what makes it discovery-shaped: a new field with a sample placeholder is caught on the day it is
// written, without anybody remembering to add it here. (The first attempt at this scan, recorded in
// #740, matched JSX with a regex that broke on nested braces and missed the very screen the
// report was about. This one reads LINES and looks at a window around them — dumber, and it does not
// silently under-count.)
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const WEB_SRC = resolve(import.meta.dirname, "..");
const en = JSON.parse(readFileSync(resolve(WEB_SRC, "i18n/locales/en.json"), "utf8")) as Record<string, unknown>;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const lookup = (key: string): string | null => {
  const hit = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
  return typeof hit === "string" ? hit : null;
};

/**
 * Does this placeholder show an EXAMPLE ANSWER rather than name the field?
 *
 * Deliberately conservative: it says yes only for shapes that cannot be read as a field name. A
 * false negative leaves a field unguarded (the status quo); a false positive would force a label
 * onto a search box, which the ruling explicitly did not ask for.
 */
function isSampleValue(text: string): boolean {
  const t = text.trim();
  if (/^(e\.g\.|例[:：])/i.test(t)) return true;              // "e.g. recycler"
  if (/^[Yy]{4}[-/][Mm]{2}[-/][Dd]{2}$/.test(t)) return true; // a date format
  if (/^\d{4,}$/.test(t)) return true;                        // "123456"
  if (/^x{3,}[-x]*$/i.test(t)) return true;                   // "xxxx-xxxx-xxxx-xxxx"
  if (/^\S+@\S+\.\S+$/.test(t)) return true;                  // "email@example.com"
  if (/^https?:\/\/\S+$/.test(t)) return true;                // a bare example URL
  // A single lower-case token with a hyphen and no spaces reads as a value, not a name ("my-team").
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(t)) return true;
  return false;
}

/** the visible-label idiom this codebase uses: a <label> wrapping the control, or an htmlFor */
const LABEL_NEAR = /<label|htmlFor=|<FieldLabel/;

interface Finding { file: string; line: number; placeholder: string }

function scan(): { checked: number; unlabelled: Finding[]; hardcodedAria: Finding[] } {
  let checked = 0;
  const unlabelled: Finding[] = [];
  const hardcodedAria: Finding[] = [];
  for (const file of walk(WEB_SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Looking BACK as well as forward: the idiom wraps the control, so the opening <label> is above.
      const window = lines.slice(Math.max(0, i - 8), i + 4).join("\n");
      if (line.includes("placeholder=")) {
        const m = /placeholder=\{t\("([^"]+)"\)\}|placeholder="([^"]+)"/.exec(line);
        const text = m ? (m[1] ? lookup(m[1]) : m[2]) : null;
        if (text && isSampleValue(text)) {
          checked += 1;
          if (!LABEL_NEAR.test(window)) {
            unlabelled.push({ file: file.slice(WEB_SRC.length + 1), line: i + 1, placeholder: text });
          }
        }
      }
      // The other half of the report: a screen-reader label written as an English literal never
      // becomes Japanese, and nothing about the screen shows that it happened.
      const aria = /aria-label="([^"]*)"/.exec(line);
      if (aria && aria[1] && !/^[A-Z]/.test(aria[1].trim())) {
        hardcodedAria.push({ file: file.slice(WEB_SRC.length + 1), line: i + 1, placeholder: aria[1] });
      }
    });
  }
  return { checked, unlabelled, hardcodedAria };
}

describe("#740: a field whose placeholder is an EXAMPLE has a label that stays", () => {
  const result = scan();

  it("the walk actually found fields to judge", () => {
    // An empty walk passes every other case in this file. This project has shipped a green check
    // over an empty list before (#719, eleven days), so the count is asserted first.
    expect(result.checked, "no sample-value placeholders found at all — the scan stopped working")
      .toBeGreaterThan(5);
  });

  it("every one of them has a visible label", () => {
    const listed = result.unlabelled.map((f) => `${f.file}:${f.line}  placeholder=${JSON.stringify(f.placeholder)}`);
    expect(listed, `these fields show an example and never say what they want:\n${listed.join("\n")}`).toEqual([]);
  });

  it("no screen-reader label is an English literal", () => {
    // #740 family B: five of these sat in one form, so a Japanese admin heard "issuer", "client id",
    // "client secret" read out in English. Proper nouns start with a capital and are allowed
    // (a product's own name is the same word in both locales); anything lower-case is prose that
    // was never translated.
    const listed = result.hardcodedAria.map((f) => `${f.file}:${f.line}  aria-label=${JSON.stringify(f.placeholder)}`);
    expect(listed, `screen-reader text that never becomes Japanese:\n${listed.join("\n")}`).toEqual([]);
  });
});
