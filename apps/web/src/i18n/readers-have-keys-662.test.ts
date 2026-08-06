import { describe, it, expect } from "vitest";
import { LANGS } from "./index";
import { ACCENT_PRESETS } from "../app/branding";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// #662: the other direction from #645.
//
// #645 sweeps keys nothing reads. This sweeps READERS WITH NO KEY, and that is the direction the API
// key form was broken in: `t(\`roleCaps.${c}\`, c)` named a namespace present in neither locale, and the
// second argument — i18next's fallback — painted the raw wire verb instead. A Japanese reader was
// offered "view edit publish" beside , and nothing was red, because a fallback is
// indistinguishable from a translation once it is on screen.
//
// So the fallback is the hazard, not the typo. A missing key with no fallback renders its own path and
// somebody sees it in a day; a missing key WITH one renders something plausible and survives.
//
// Interpolated keys can only be checked to their prefix — `t(\`adminRoles.cap.${c}\`)` may reach any leaf
// under `adminRoles.cap`, and which one depends on data this scan cannot evaluate. Requiring the PREFIX
// to exist is still enough to have caught #662, whose whole prefix was absent.
const SRC = resolve(import.meta.dirname, "..");
const LOCALES = resolve(import.meta.dirname, "locales");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (name === "locales" || name === "node_modules") continue;
    // This file and #645's name keys in prose; scanning them would measure the explanations.
    if (/^(no-orphan-keys-645|readers-have-keys-662)\.test\.ts$/.test(name)) continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const load = (f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(LOCALES, f), "utf8")) as Record<string, unknown>;

/**
 * Does `path` resolve in this locale?
 *
 * Three shapes, and getting any of them wrong makes the scan report the product as broken when it is
 * not — which is worse than not scanning, because the next person turns the scan off:
 *
 *  - a plain leaf: `adminApi.narrowHint`
 *  - a PLURAL leaf: `t("x.y", { count })` resolves `x.y_one` / `x.y_other`, and `x.y` itself may not
 *    exist at all. Japanese has one plural form, so `_one` legitimately exists only in English.
 *  - an interpolated PREFIX, of which there are two kinds: `adminRoles.cap.${c}` (the parent is an
 *    object, take any child) and `account.keymap_${x}` (the keys are FLAT under `account`, and
 *    `keymap_` is a fragment of a sibling's name, not a container).
 */
function resolves(obj: Record<string, unknown>, path: string, interpolated: boolean): boolean {
  const walk = (segs: string[]): unknown => {
    let cur: unknown = obj;
    for (const seg of segs) {
      if (typeof cur !== "object" || cur === null || !(seg in (cur as object))) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };
  const segs = path.split(".");
  if (!interpolated) {
    const direct = walk(segs);
    if (typeof direct === "string") return true;
    // the plural forms, which are what the key actually resolves to when `count` is passed
    const parent = walk(segs.slice(0, -1));
    const last = segs[segs.length - 1]!;
    return typeof parent === "object" && parent !== null
      && (`${last}_one` in parent || `${last}_other` in parent);
  }
  // interpolated: the static part is `parent.partial`, where `partial` may be empty
  const parentSegs = path.includes(".") ? segs.slice(0, -1) : [];
  const partial = path.includes(".") ? segs[segs.length - 1]! : path;
  const parent = walk(parentSegs);
  if (typeof parent !== "object" || parent === null) return false;
  // `adminRoles.cap.${c}` arrives here as parent=adminRoles, partial=cap — an object child
  const asChild = (parent as Record<string, unknown>)[partial];
  if (typeof asChild === "object" && asChild !== null && Object.keys(asChild as object).length > 0) return true;
  // `account.keymap_${x}` arrives as parent=account, partial=keymap_ — a name fragment
  return Object.keys(parent as object).some((k) => k.startsWith(partial) && k !== partial);
}

/**
 * Readers whose key is genuinely absent from BOTH locales — found by this scan on the day it was
 * written, and NOT fixed here because each needs user-facing copy in two languages and this ticket is
 * about the API key form. Recorded rather than excluded: an entry is a promise, and the list shrinking
 * is how anyone can tell the promise was kept.
 *
 * Both are visible today. Deleting a page with backlinks prints the literal `delete.backlinkWarning`
 * inside the warning box, and the group-roles mark announces `members.groupRolesMark` to a screen
 * reader. Note `no-dash-copy-585.test.ts` still calls `delete.backlinkWarning_one` "the live example" —
 * the key went and the comment and the reader both stayed.
 */
const KNOWN_MISSING: Record<string, string> = {
  // #668 emptied this. Both entries were real defects rather than exemptions — one printed the key into
  // a warning box, the other handed it to a screen reader — so the ledger shrank when they were fixed,
  // which is the only way a ledger of known holes can show that anything was done about them.
};

/** Every `t("…")` / `t(\`…\`)` in the source, as {path, interpolated}. */
function readers(): { file: string; path: string; interpolated: boolean }[] {
  const out: { file: string; path: string; interpolated: boolean }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // a plain string key
    for (const m of src.matchAll(/\bt\(\s*"([A-Za-z][\w.]*)"/g)) {
      out.push({ file: file.slice(file.indexOf("/src/") + 1), path: m[1]!, interpolated: false });
    }
    // a template literal — take the static prefix up to the first `${`
    for (const m of src.matchAll(/\bt\(\s*`([A-Za-z][\w.]*)\$\{/g)) {
      const prefix = m[1]!.replace(/\.$/, "");
      if (prefix.includes(".")) out.push({ file: file.slice(file.indexOf("/src/") + 1), path: prefix, interpolated: true });
    }
  }
  return out;
}

describe("#662: every t() names something the locales actually have", () => {
  const ja = load("ja.json");
  const en = load("en.json");

  it("the scan finds readers (a broken pattern must not pass vacuously)", () => {
    const r = readers();
    expect(r.length, "no t() calls found — the scan measures nothing").toBeGreaterThan(50);
    expect(r.some((x) => x.interpolated), "no interpolated key found — the #662 shape would be missed")
      .toBe(true);
  });

  for (const [name, loc] of [["ja", ja], ["en", en]] as const) {
    it(`${name}: no reader points at a key that is not there`, () => {
      const missing = readers()
        .filter((r) => !resolves(loc as Record<string, unknown>, r.path, r.interpolated))
        .map((r) => `${r.file} → ${r.path}${r.interpolated ? ".*" : ""}`)
        .filter((k) => !(k in KNOWN_MISSING));
      expect(
        [...new Set(missing)],
        `these read a key ${name}.json does not have. With a fallback the screen shows something ` +
        `plausible and nobody notices — which is exactly how #662 shipped`,
      ).toEqual([]);
    });
  }

  // #669: the interpolated readers whose candidate set is a CONSTANT, checked key by key.
  //
  // Above, an interpolated reader is satisfied by its static prefix existing — `t(\`language.${l}\`)`
  // passes as long as `language` has any key at all. That is the right reading when the suffix comes
  // from data nobody can enumerate, and it is why #645's cleanup could delete `language.en` and
  // `language.ja` while every gate stayed green: the toggle then listed its own keys as the menu, in
  // both languages, on every screen in the product.
  //
  // Where the suffixes ARE enumerable the concrete keys can be checked, and the list is imported from
  // the source rather than copied — a third language added to `LANGS` is covered the day it is added,
  // which a copy here would not be.
  const ENUMERABLE: { what: string; keys: string[] }[] = [
    { what: "the language menu (LANGS)", keys: LANGS.map((l) => `language.${l}`) },
    // The same cleanup took these too, and for the same reason — all three readers interpolate. The
    // theme menu and the accent picker were listing `theme.light` and `accent.blue` at people.
    { what: "the theme menu", keys: ["light", "dark", "system"].map((t) => `theme.${t}`) },
    { what: "the accent picker (ACCENT_PRESETS)", keys: ACCENT_PRESETS.map((a) => `accent.${a}`) },
  ];

  for (const [name, loc] of [["ja", ja], ["en", en]] as const) {
    it(`${name}: an interpolated reader over a known list has every key it will ask for`, () => {
      const missing = ENUMERABLE.flatMap(({ what, keys }) =>
        keys.filter((k) => !resolves(loc as Record<string, unknown>, k, false)).map((k) => `${what}: ${k}`));
      expect(missing, `${name}.json is missing keys this reader will certainly ask for`).toEqual([]);
    });
  }

  it("the API key form uses the capability vocabulary, not a second one", () => {
    // The specific regression. `role-nouns.ts` records the ruling: a ROLE NAME is a proper noun and is
    // never translated; a CAPABILITY is, and that vocabulary lives on the surface that edits a role
    // definition. Choosing what a key may do is that surface, so it borrows those words rather than
    // inventing a parallel set that would drift.
    // Comments STRIPPED first. The fix's own comments name both dead namespaces to explain them, and a
    // check that reads its own explanation reports a defect that is not there — the fourth time that
    // shape has bitten in a single day on this board.
    const panel = readFileSync(resolve(SRC, "settings/ApiKeysPanel.tsx"), "utf8")
      .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // BOTH readers: the form (the reported symptom) and the list two panels down, which had the same
    // defect under a different invented namespace and was found by the scan rather than by looking.
    expect(panel, "the API key panel invented its own capability namespace again")
      .not.toMatch(/roleCaps\.|adminApi\.cap_/);
    expect(panel.match(/adminRoles\.cap\./g) ?? [], "both the list and the form read the real one")
      .toHaveLength(2);
    for (const cap of ["view", "edit", "publish", "delete", "comment", "manage"]) {
      expect(resolves(ja, `adminRoles.cap.${cap}`, false), `ja is missing adminRoles.cap.${cap}`).toBe(true);
      expect(resolves(en, `adminRoles.cap.${cap}`, false), `en is missing adminRoles.cap.${cap}`).toBe(true);
    }
  });
});
