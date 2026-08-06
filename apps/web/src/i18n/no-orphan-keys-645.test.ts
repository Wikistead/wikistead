import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// #645 (user ruling, 2026-08-06): a locale key nothing reads is a lie about the product.
//
// Two of them survived #579, which replaced the invite screen's role prompt with a permanent dropdown
// two invite-role prompts still sat in both files with no reader. The
// harm is not the bytes — it is that the next person assumes a key is live, and that every language
// added from now on counts them as work.
//
// The ruling is explicit that naming those two and stopping is not the fix (" 2
// "), so this sweeps every key instead.
//
// The hard part is that a key is not always written out. Several call sites BUILD one
//
// t(`adminRoles.cap.${c}`) t(`spaceAnalytics.preset_${p.key}`) t(`roles.${scope}`)
//
// A literal-only search calls all of those orphans and would delete keys the product reads every day. So
// a key counts as referenced if any PREFIX of it is interpolated, which is what a template literal can
// reach. The cost is that a genuinely dead `foo.bar.baz` hides behind a live `t(\`foo.bar.${x}\`)` — the
// safe direction, and the one this sweep is willing to be wrong in.
const SRC = resolve(import.meta.dirname, "..");
// …and the e2e specs, which drive the product by the words on screen. A key only an e2e names is still
// read by something, and deleting it breaks a pin rather than tidying anything.
const E2E = resolve(import.meta.dirname, "../../../../tests/e2e");
const LOCALES = resolve(import.meta.dirname, "locales");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (name === "locales" || name === "node_modules") continue;
    // this file is skipped below (it names keys in prose, which would make them look live)
    if (name === "no-orphan-keys-645.test.ts") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    // tests count as readers: several pins assert on a specific string, and deleting the key it names
    // breaks them — which is the product's own record of what that key is for.
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every leaf key in a locale file, dotted. */
function leaves(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k));
}

const read = (lang: string) => JSON.parse(readFileSync(resolve(LOCALES, `${lang}.json`), "utf8")) as unknown;

describe("#645: no locale key without a reader", () => {
  const en = leaves(read("en"));
  const ja = leaves(read("ja"));
  const code = [...sourceFiles(SRC), ...sourceFiles(E2E)].map((f) => readFileSync(f, "utf8")).join("\n");

  it("the two files describe the same product", () => {
    // Deleting from one side only leaves a language quietly missing a string. The sets are compared
    // rather than the counts: two files can agree on size and disagree on content.
    //
    // Plural SUFFIXES are excluded, because languages disagree about them by design: i18next gives
    // English `_one` and `_other` and Japanese only `_other`, so demanding identical sets would ask ja
    // for a form its grammar does not have.
    const stem = (k: string) => k.replace(/_(?:zero|one|two|few|many|other)$/, "");
    expect([...new Set(en.map(stem))].sort(), "en has a key ja does not")
      .toEqual([...new Set(ja.map(stem))].sort());
  });

  it("the sweep can actually see references (a broken walk must not pass vacuously)", () => {
    expect(en.length, "keys were parsed out of the locale file").toBeGreaterThan(200);
    expect(code.length, "source files were read").toBeGreaterThan(100_000);
    // and a key everybody knows is live reads as live
    expect(code).toContain("members.title");
  });

  it("every key is read from somewhere", () => {
    // a key is live if it appears whole, or if any prefix of it is interpolated
    // A prefix only counts if it reaches INTO a namespace — `foo.` or `foo.bar_`. Any template literal
    // in the tree matches this regex, so without that rule a stray `` `m${x}` `` contributes the prefix
    // "m" and swallows every key beginning with it. Measured: the whole sweep passed with a deleted key
    // put back, because one such literal existed somewhere in the source.
    const interpolated = new Set<string>();
    // Two shapes of interpolated key, and the second is easy to miss: the value can be spliced into the
    // MIDDLE of a word (`contextMenu.align${Cap}`), not only after a separator. Deleting on the first
    // shape alone removed three live keys here before this was measured.
    for (const m of code.matchAll(/`([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]*)+)\$\{/g)) {
      const p = m[1].replace(/\.$/, "");
      // kept WITH its trailing separator when it has one: `account.keymap_` is a different claim from
      // `account.keymap`, and collapsing them lets a namespace swallow neighbours it never names.
      if (p || m[1].endsWith("_")) interpolated.add(m[1].endsWith("_") ? m[1] : p);
    }
    // …and `foo.bar_` style prefixes match by plain string, since the boundary is already in them
    const openEnded = [...interpolated].filter((p) => p.endsWith("_"));
    // A STRING prefix, not a dotted one: half the interpolated call sites join with an underscore
    // (`account.keymap_${v}`, `adminApi.scope_${s}`, `spaceAnalytics.preset_${k}`), so splitting on dots
    // finds nothing and calls every one of those keys an orphan. Measured: 40 live keys reported dead.
    // `startsWith` on the DOTTED path, so a one-namespace prefix reaches a key nested two deep
    // `t(\`eventTypes.${type}\`)` is fed `page.published`, and the key really is `eventTypes.page.published`.
    // Matched at a boundary (the next character is `.` or `_`) so `members` cannot claim `membersFoo`.
    const orphans = en.filter((k) =>
      !code.includes(k)
      && ![...interpolated].some((p) => k === p || (k.startsWith(p) && /[._]/.test(k[p.length] ?? "")))
      && !openEnded.some((p) => k.startsWith(p))
      // …and a prefix that ends mid-word claims what continues it: `contextMenu.align` covers
      // `contextMenu.alignLeft`, which no separator rule would ever match.
      && ![...interpolated].some((p) => p.includes(".") && k.startsWith(p)));

    expect(orphans, `locale keys nothing reads (delete them, or point a reader at them):\n${orphans.join("\n")}`)
      .toEqual([]);
  });
});

// #645: the sweep above deletes things, so what it calls LIVE has to be right too.
//
// It was wrong twice while being written, in both directions: a stray one-character prefix made every
// key look live (a deleted key could be put back and nothing complained), and a value spliced into the
// middle of a word made three keys the context menu reads every day look dead. The first costs a pin;
// the second costs a string on screen.
describe("#645: the sweep's idea of a reference", () => {
  const code = [...sourceFiles(SRC), ...sourceFiles(E2E)].map((f) => readFileSync(f, "utf8")).join("\n");
  const en = leaves(read("en"));

  it("recognises a value spliced into the middle of a key", () => {
    // `contextMenu.align${Cap}` — the interpolation does not follow a separator
    expect(code, "the call site this protects still exists").toMatch(/contextMenu\.align\$\{/);
    for (const k of ["contextMenu.alignLeft", "contextMenu.alignCenter", "contextMenu.alignRight"]) {
      expect(en, `${k} is present`).toContain(k);
    }
  });

  it("recognises a key nested below the interpolated namespace", () => {
    // `eventTypes.${type}` is handed `page.published`, two levels down
    expect(code, "the call site this protects still exists").toMatch(/eventTypes\.\$\{/);
    expect(en, "eventTypes.page.published is present").toContain("eventTypes.page.published");
  });
});
