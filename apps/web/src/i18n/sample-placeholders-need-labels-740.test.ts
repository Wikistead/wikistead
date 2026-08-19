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
const ja = JSON.parse(readFileSync(resolve(WEB_SRC, "i18n/locales/ja.json"), "utf8")) as Record<string, unknown>;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const at = (cat: Record<string, unknown>, key: string): string | null => {
  const hit = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cat);
  return typeof hit === "string" && hit.trim() !== "" ? hit : null;
};
const lookup = (key: string): string | null => at(en, key);
const lookupJa = (key: string): string | null => at(ja, key);

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
  // #740three shapes the first version could not see, found by counting the family by hand.
  // A bare host name (`youtube.com`, `docs.example.com`) is one of the answers, not the question.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return true;
  // A comma-separated list of examples ("engineering, admins") is two answers, not a name.
  if (/^[a-z0-9-]+(,\s*[a-z0-9-]+)+$/.test(t)) return true;
  // A pasted document's first line (`-----BEGIN CERTIFICATE-----`) shows the shape of the paste.
  if (/^-{3,}BEGIN /.test(t)) return true;
  return false;
}

/**
 * Is the control INSIDE a label, and does that label say anything?
 *
 * #740measured the first version of this and it had no teeth. It looked for the string
 * `<label` in an eight-line window, which is true of two different situations:
 *
 *   - the idiom this codebase uses, `<label>{t("…")}<Input …/></label>` — correct;
 *   - a SECTION HEADING three lines above an unwrapped input, `<label>Create an API key</label>` —
 *     which names the form, not the field, and was passing on three screens.
 *
 * And it stayed green when the label element was kept and its TEXT deleted, which is the reported
 * defect exactly: a box with an example in it and nothing saying what it wants. So the window is
 * gone. The label has to ENCLOSE the control (no `</label>` between the two), and it has to contain
 * a translation key that resolves to real words in BOTH locales — an empty label, or one whose key
 * has no Japanese, is the same blank screen to the reader who needed it.
 */
const LABEL_OPEN = /<label\b([^>]*)>/;

/**
 * The only English literals a screen reader may hear: names that are the same word in every locale.
 *
 * #740the first version exempted anything starting with a capital, and the only live defect
 * left in the tree started with a capital — `aria-label="Resize sidebar"`, read out in English to
 * somebody looking at a Japanese screen. A rule shaped around the current spelling habits exempts
 * exactly the thing it was written to catch. The exception is a list now, and each entry has to be
 * a name rather than a sentence.
 */
const PROPER_NOUNS = new Set(["Wikistead"]);

/** A label the reader cannot see is the defect wearing the accessible name's clothes. */
const HIDDEN = /sr-only|\bhidden\b|opacity-0/;

interface Finding { file: string; line: number; placeholder: string; why?: string }
/** A field that passed: what it shows as an example, and what it calls itself. */
interface Named { file: string; line: number; placeholder: string; label: string }

/**
 * Two fields may show the same example and still be asking different questions.
 *
 * Each entry is a placeholder whose sample is a FORMAT rather than an answer, so repeating it across
 * differently-named fields is correct. Written out with the reason, because the alternative — letting
 * the naming check off whenever it finds a disagreement — is the check not existing.
 */
const SAME_EXAMPLE_DIFFERENT_QUESTION: Record<string, string> = {
  "YYYY-MM-DD": "the two ends of one date range; the example is the FORMAT both ends take, and 'From' and 'To' are the whole difference between them",
};

/**
 * Why this control has no usable label, or null when it has one.
 *
 * Two questions, because the defect has two shapes.
 *
 * FIRST, does a label exist and say anything? Walking backwards finds the nearest `<label>`, and its
 * CONTENT has to resolve to real words in both locales. That is the half the first version missed:
 * keep the element and delete its text and the screen shows a box with an example in it and nothing
 * else, which is the report verbatim — and it stayed green (#740, measured).
 *
 * SECOND, is the field's name only in the screen reader? A sample-value field carrying an
 * `aria-label` is an author saying "this field needs its own name" and then putting that name where
 * it cannot be seen. That signal is what separated the three screens the review found from the ones
 * that were fine: `<label>Create an API key</label>` above an `aria-label`led input names the FORM,
 * and the field's own name was audible only.
 *
 * ⚠️ WHAT THIS CANNOT SEE, said rather than implied: a section heading sitting directly above a lone
 * field, with no `aria-label` on it, is indistinguishable from a field label at this level. Telling
 * them apart means reading the words, and a rule that guesses at prose goes red on correct pages.
 * The `aria-label` signal covers every instance in the tree today; a future one written without it
 * would need the walk to render, which is #650's shape and costs a mock per screen.
 */
function labelProblem(lines: string[], at: number): string | null {
  for (let i = at; i >= 0 && i > at - 40; i--) {
    const open = LABEL_OPEN.exec(lines[i]!);
    if (!open) continue;
    if (HIDDEN.test(open[1] ?? "")) return "the label is hidden from sight";
    // The label's OWN words end where its control begins. Reading past that point finds the
    // placeholder's `t(...)` and calls it the label — which is how an empty label passed: the very
    // string this walk exists to distrust was being counted as the name of the field it sits in.
    let textEnd = i;
    while (textEnd < at && !/<(Input|input|textarea|Textarea|Select)\b/.test(lines[textEnd]!)) textEnd += 1;
    const span = lines.slice(i, textEnd).join("\n").replace(LABEL_OPEN, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
    const key = /\{\s*t\("([^"]+)"[^}]*\}/.exec(span)?.[1];
    if (key) {
      if (!lookup(key)) return `the label reads t("${key}"), which resolves to nothing in English`;
      if (!lookupJa(key)) return `the label reads t("${key}"), which has no Japanese`;
    } else if (!/\S/.test(span.replace(/\{\s*(""|''|``|null|false|undefined)\s*\}/g, ""))) {
      // Nothing renders here. A label element whose content is `{}` reads to a person exactly like
      // no label at all, and that is the state the report described. An expression this walk cannot
      // follow (`{NAME[method]}`, built from `t(...)` above) is accepted rather than guessed at
      // said here so nobody reads the check as stronger than it is.
      return "the label element has no words in it";
    }
    // The label exists and says something — but does it name THIS field? An `aria-label` carrying a
    // DIFFERENT name is the author answering that question themselves: the visible words belong to
    // the form, and the field's own name was put where only a screen reader finds it. Where the two
    // names agree the aria-label is merely redundant, which is not this ticket's defect.
    // Scoped to THIS control's own element: start at the tag that opens it and read to the end of
    // its attributes. A fixed window backwards reads the field ABOVE this one, and then a dialog
    // with two properly labelled fields reports the first one's name against the second one's label
    // (measured, on the link dialog).
    let from = at;
    while (from > 0 && !/<(Input|input|textarea|Textarea)\b/.test(lines[from]!)) from -= 1;
    const aria = /aria-label=\{\s*t\("([^"]+)"[^}]*\}|aria-label="([^"]*)"/.exec(
      lines.slice(from, at + 4).join("\n"),
    );
    const ariaName = aria ? (aria[1] ? lookup(aria[1]) : aria[2]) : null;
    // Only comparable when the label's words are a key this walk can resolve; a label built from an
    // expression is accepted above and cannot be compared here either.
    const shown = key ? lookup(key) : null;
    if (ariaName && shown && ariaName !== shown) {
      return `the label above says ${JSON.stringify(shown)} while the field's own name, ${JSON.stringify(ariaName)}, is in its aria-label where only a screen reader finds it`;
    }
    return null;
  }
  return "no label names this control";
}

/**
 * The words this field calls itself, in English, or null when they cannot be resolved.
 *
 * Only called for fields `labelProblem` already passed, so the label is known to exist and to resolve
 * in both locales; this repeats the walk back to read the key rather than threading it out, because
 * the two questions are asked for different reasons and one of them may stop being asked.
 */
function labelShown(lines: string[], at: number): string | null {
  for (let i = at; i >= 0 && i > at - 40; i--) {
    if (!LABEL_OPEN.test(lines[i]!)) continue;
    let textEnd = i;
    while (textEnd < at && !/<(Input|input|textarea|Textarea|Select)\b/.test(lines[textEnd]!)) textEnd += 1;
    const span = lines.slice(i, textEnd).join("\n").replace(LABEL_OPEN, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
    const key = /\{\s*t\("([^"]+)"[^}]*\}/.exec(span)?.[1];
    return key ? lookup(key) : null;
  }
  return null;
}

function scan(): { checked: number; unlabelled: Finding[]; hardcodedAria: Finding[]; named: Named[] } {
  let checked = 0;
  const unlabelled: Finding[] = [];
  const hardcodedAria: Finding[] = [];
  const named: Named[] = [];
  for (const file of walk(WEB_SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("placeholder=")) {
        const m = /placeholder=\{t\("([^"]+)"\)\}|placeholder="([^"]+)"/.exec(line);
        const text = m ? (m[1] ? lookup(m[1]) : m[2]) : null;
        if (text && isSampleValue(text)) {
          checked += 1;
          const why = labelProblem(lines, i);
          if (why) {
            unlabelled.push({ file: file.slice(WEB_SRC.length + 1), line: i + 1, placeholder: text, why });
          } else {
            const label = labelShown(lines, i);
            if (label) named.push({ file: file.slice(WEB_SRC.length + 1), line: i + 1, placeholder: text, label });
          }
        }
      }
      // The other half of the report: a screen-reader label written as an English literal never
      // becomes Japanese, and nothing about the screen shows that it happened.
      const aria = /aria-label="([^"]*)"/.exec(line);
      if (aria && aria[1] && !PROPER_NOUNS.has(aria[1].trim())) {
        hardcodedAria.push({ file: file.slice(WEB_SRC.length + 1), line: i + 1, placeholder: aria[1] });
      }
    });
  }
  return { checked, unlabelled, hardcodedAria, named };
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
    const listed = result.unlabelled.map((f) => `${f.file}:${f.line}  placeholder=${JSON.stringify(f.placeholder)} — ${f.why}`);
    expect(listed, `these fields show an example and never say what they want:\n${listed.join("\n")}`).toEqual([]);
  });

  it("fields showing the same example call themselves the same thing", () => {
    // #671, arrived at through this ticket (user ruling). The sign-in door asked for "Code", the
    // enrolment confirm asked for "Code", the factor-removal confirm asked for "Code", and the recovery
    // re-auth — written last, by the ticket that started all this — asked for "Authenticator code".
    // Four boxes containing `123456`, three of them named after the noun and one after the question.
    // Fixing the three named in the ruling would have left the rule where it was: in nobody's head.
    //
    // The family is DISCOVERED from the example each field shows, not listed. A fifth screen asking for
    // a code, written by somebody who never read this ticket, is grouped with the other four the day it
    // is written and has to agree with them.
    const groups = new Map<string, Named[]>();
    for (const f of result.named) {
      if (SAME_EXAMPLE_DIFFERENT_QUESTION[f.placeholder]) continue;
      const g = groups.get(f.placeholder) ?? [];
      g.push(f);
      groups.set(f.placeholder, g);
    }
    const shared = [...groups.values()].filter((g) => g.length > 1);
    expect(shared.length, "no example is shown by two fields at all — the grouping stopped working")
      .toBeGreaterThan(0);
    const split = shared
      .filter((g) => new Set(g.map((f) => f.label)).size > 1)
      .map((g) => `placeholder ${JSON.stringify(g[0]!.placeholder)} is asked for under ${new Set(g.map((f) => f.label)).size} names:\n${g.map((f) => `    ${f.file}:${f.line}  ${JSON.stringify(f.label)}`).join("\n")}`);
    expect(split, `one question, more than one name:\n${split.join("\n")}`).toEqual([]);
  });

  it("no screen-reader label is an English literal", () => {
    // #740 family B: five of these sat in one form, so a Japanese admin heard "issuer", "client id",
    // "client secret" read out in English. The exemption is the named list above — a product's own
    // name is the same word in both locales, and everything else is prose that was never translated.
    const listed = result.hardcodedAria.map((f) => `${f.file}:${f.line}  aria-label=${JSON.stringify(f.placeholder)}`);
    expect(listed, `screen-reader text that never becomes Japanese:\n${listed.join("\n")}`).toEqual([]);
  });
});
