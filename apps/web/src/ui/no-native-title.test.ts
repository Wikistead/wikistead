// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// #530 anti-drift: the native `title` tooltip is BANNED in app code. It waits ~1–2s under browser
// control, cannot be themed, and never shows on keyboard focus — which is why #530 replaced every use
// with the fast tooltip (`<Tooltip>` for React, `data-tip` for DOM built outside it). Without this test
// the next `title="…"` slips back in and the inconsistency returns one control at a time (the
// api-inventory-407 shape: a grep pin whose exception list is REVIEWED, not a dumping ground).
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

// Legitimate `title` that is NOT a tooltip. Each entry is a REVIEWED exception, matched on the source
// line, so a new tooltip-shaped use in the same file still fails.
const ALLOWED_LINE = [
  // A COMPONENT prop (capitalised tag on the same line): a panel/dialog heading, not a hover bubble.
  // EXCEPT the interactive wrappers — an IconButton/Button/Trigger `title` IS a tooltip and must move
  // to data-tip like any other (this is the case the pin exists to catch).
  /<(?!(?:IconButton|Button|ToggleButton|DropdownMenuTrigger|TooltipTrigger)\b)[A-Z][\w.]*\b[^>]*\stitle=/,
  // A component prop whose tag opened on an earlier line (the attribute sits alone on this one).
  /^\s*title=\{?["'`<]?/,
  /^\s*\/\/|^\s*\*|^\s*\/\*/, //  comments (including this file's own prose and docs about `title=`)
  /\btitle:\s/, //                object literals (menu items, i18n payloads, macro descriptors)
  /<title\b/, //                  SVG <title> — an accessible name, not a tooltip
  /document\.title/, //           the browser tab title
  /\b(?:frame|iframe)\.title\s*=/, // <iframe title> IS the accessible name (required by a11y)
  /\.title\b\s*(?:\?\?|\|\||\)|,|;|\}|$)/, // READING a .title property (page.title, fence.title, …)
  /\binfo\.title\b/, //           fence info-string metadata (the filename in ```ts title="x")
];

// A `title=` (JSX) or `.title =` / setAttribute("title" (DOM) that is a TOOLTIP.
const TOOLTIP_SHAPED = [
  /\stitle=\{(?!\s*<)/, //          JSX attribute holding a string expression
  /\stitle="[^"]/, //               JSX attribute holding a literal
  /\.title\s*=\s*[^=]/, //          DOM assignment
  /setAttribute\(\s*["']title["']/, // DOM setAttribute
];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "__snapshots__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) yield p;
  }
}

describe("#530: no native `title` tooltips in app code", () => {
  it("every tooltip goes through the fast tooltip (Tooltip / data-tip), not the native title", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!TOOLTIP_SHAPED.some((re) => re.test(line))) return;
        if (ALLOWED_LINE.some((re) => re.test(line))) return;
        offenders.push(`${relative(srcRoot, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      offenders,
      `native title tooltips found — use <Tooltip content=…> (React) or el.dataset.tip (DOM), or add a REVIEWED exception:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
