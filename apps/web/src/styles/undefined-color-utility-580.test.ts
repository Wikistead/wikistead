// #580 review 1: a colour utility whose token does not exist renders NOTHING — and nothing looks
// like "styled, just subtly" until someone measures it. The segment control was the third instance:
// `bg-bg-subtle` on the SELECTED segment produced `rgba(0,0,0,0)`, so the only difference between
// chosen and unchosen was the font weight. tokens.css opens with a comment calling this out as "the
// root cause of the recurring undefined token bugs" — it had a fix for the bare shadcn names and no
// guard for the utility side.
//
// So this is a DISCOVERY pin, not a list of the four we knew about: it derives the legal names from
// the `@theme` block and reports every utility in the source that asks for something else. Measured in
// the built CSS at the time of writing (`.text-fg{...}` and `.bg-bg-subtle{...}` are absent while
// `.text-fg-dim` and `.bg-panel-2` are present), which is what makes "generated nothing" a fact here
// rather than an inference.
//
// SCOPE, said plainly: colour only (`--color-*`). Tailwind's other namespaces have the same failure
// mode — `text-ui` is written in 13 places and `--text-ui` lives in `:root`, not in `@theme`, so those
// generate nothing either — but registering a font SIZE changes what the screen looks like, which is a
// review matter and not a bounce fix. It is reported on the ticket instead of quietly widened
// into here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");

const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p);
    }
  };
  walk(SRC);
  return out;
};

/** The names Tailwind will actually generate a colour utility for: the `--color-*` keys in @theme. */
const definedColours = (): Set<string> => {
  const css = readFileSync(join(SRC, "styles/tokens.css"), "utf8");
  const at = css.indexOf("@theme");
  const block = css.slice(at, css.indexOf("}", at));
  return new Set([...block.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
};

// Tailwind's own palette and keywords need no token.
const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|\d{3})$/;
const KEYWORD = new Set(["white", "black", "transparent", "current", "inherit", "none"]);
// Same prefixes, different property — these are not colour utilities at all.
const NOT_A_COLOUR: Record<string, Set<string>> = {
  bg: new Set(["gradient-to-b", "gradient-to-r", "gradient-to-t", "gradient-to-l", "cover", "contain", "center", "clip-text", "clip-border", "no-repeat", "fixed", "local", "scroll"]),
  text: new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "left", "center", "right", "justify", "start", "end", "ellipsis", "clip", "wrap", "nowrap", "balance", "pretty", "top", "bottom", "middle"]),
  border: new Set(["0", "2", "4", "8", "t", "b", "l", "r", "x", "y", "t-0", "b-0", "t-2", "b-2", "l-0", "r-0", "collapse", "separate", "solid", "dashed", "dotted", "double", "hidden", "spacing", "box", "radius", "color"]),
  ring: new Set(["0", "1", "2", "4", "8", "inset"]),
  fill: new Set([]),
  // `stroke-width` and friends are SVG ATTRIBUTE names, not utilities — they appear wherever this app
  // builds an svg (the export's icon allow-list, #85). Tailwind has no colour utility by those names, so
  // they belong here for the same reason `bg-cover` does: same prefix, different property.
  stroke: new Set(["0", "1", "2", "width", "linecap", "linejoin", "dasharray", "dashoffset", "opacity", "miterlimit"]),
};

/** `ring-offset-2` sets a WIDTH and `ring-offset-background` sets a colour — same prefix, and the
 *  colour half names a normal token. Returns null for the ones that are not colours at all. */
const normalise = (prefix: string, name: string): string | null => {
  if (prefix !== "ring" || !name.startsWith("offset-")) return name;
  const rest = name.slice("offset-".length);
  return /^\d+$/.test(rest) ? null : rest;
};

/** A utility token, with its variants (`hover:`, `dark:`) and opacity (`/50`) stripped. Only matched at
 *  a real word start, so `cm-lp-todo-ring-arc` is a class NAME and not a `ring-arc` utility. */
const UTILITY = /(?:^|[\s"'`{])(?:[a-z-]+:)*(bg|text|border|ring|fill|stroke)-([a-zA-Z0-9-]+)(?:\/\d+)?(?=[\s"'`}]|$)/g;

const offenders = (): string[] => {
  const defined = definedColours();
  const found: string[] = [];
  for (const file of sources()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // only class strings — a bare identifier elsewhere in the file is not a utility
      if (!/className|class=|classNames|cva\(/.test(line) && !/^\s*["'`]/.test(line)) return;
      const stripped = line.replace(/\[[^\]]*\]/g, "[]"); // arbitrary values carry CSS property names
      for (const m of stripped.matchAll(UTILITY)) {
        const [, prefix, raw] = m as unknown as [string, string, string];
        const name = normalise(prefix, raw);
        if (name === null || NOT_A_COLOUR[prefix]?.has(name) || KEYWORD.has(name) || PALETTE.test(name) || defined.has(name)) continue;
        found.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${prefix}-${name}`);
      }
    });
  }
  return found;
};

describe("#580: a colour utility names a token that exists", () => {
  it("no utility in the app asks for a colour @theme does not define", () => {
    expect(offenders(), "these render with NO colour at all — define the token in tokens.css @theme, or use one that exists").toEqual([]);
  });

  it("the scanner reads the token list from tokens.css rather than repeating it", () => {
    const defined = definedColours();
    // if this list were hand-written it would drift the first time someone adds a token; these four
    // are the ones the offending sites were changed TO, so they must resolve through the real file
    for (const name of ["panel-2", "fg-dim", "fg", "border"]) expect(defined.has(name), `--color-${name} is mapped`).toBe(true);
    expect(defined.has("bg-subtle"), "and the one that started this is still not a token").toBe(false);
  });

  it("recognises the shapes this repo actually writes", () => {
    // guard the guard: each of these must be classified the way the comment claims
    const defined = definedColours();
    const classify = (line: string): string[] => {
      const out: string[] = [];
      const stripped = line.replace(/\[[^\]]*\]/g, "[]");
      for (const m of stripped.matchAll(UTILITY)) {
        const [, prefix, raw] = m as unknown as [string, string, string];
        const name = normalise(prefix, raw);
        if (name === null || NOT_A_COLOUR[prefix]?.has(name) || KEYWORD.has(name) || PALETTE.test(name) || defined.has(name)) continue;
        out.push(`${prefix}-${name}`);
      }
      return out;
    };
    expect(classify('className="rounded bg-bg-subtle px-1"'), "the reported bug").toEqual(["bg-bg-subtle"]);
    expect(classify('className={`x ${on ? "bg-nope-2" : "text-fg-dim"}`}'), "inside a template branch").toEqual(["bg-nope-2"]);
    expect(classify('className="hover:text-made-up"'), "behind a variant").toEqual(["text-made-up"]);
    expect(classify('className="cm-lp-todo-ring-arc"'), "a class NAME that ends in a utility-looking word").toEqual([]);
    expect(classify('className="transition-[color,background-color,border-color]"'), "CSS property names in an arbitrary value").toEqual([]);
    expect(classify('className="text-[11px] text-sm border-b bg-black/40 text-red-500"'), "sizes, sides, palette, opacity").toEqual([]);
    expect(classify('className="bg-panel-2 text-fg-dim border-border"'), "the real tokens").toEqual([]);
    expect(classify('className="ring-offset-2 ring-offset-background"'), "one prefix, a width and a colour").toEqual([]);
    expect(classify('className="ring-offset-nope"'), "…and the colour half is still checked").toEqual(["ring-nope"]);
  });
});
