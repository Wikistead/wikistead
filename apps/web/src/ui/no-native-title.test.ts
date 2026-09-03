// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// #530 anti-drift: the native `title` tooltip is BANNED in app code. It waits ~1–2s under browser
// control, cannot be themed, and never shows on keyboard focus — which is why #530 replaced every use
// with the fast tooltip (`<Tooltip>` for React, `data-tip` for DOM built outside it). Without this test
// the next `title="…"` slips back in and the inconsistency returns one control at a time (the
// api-inventory-407 shape: a grep pin whose exception list is REVIEWED, not a dumping ground).
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

// Legitimate `title` that is NOT a tooltip. Each entry is a REVIEWED exception, matched on the source
// line, so a new tooltip-shaped use in the same file still fails. These cover the DOM-assignment forms
// below, which stay a per-line check — an assignment statement cannot span a JSX tag opening the way an
// attribute can, so the #1044 bug (below) does not apply to them.
const ALLOWED_LINE = [
  /^\s*\/\/|^\s*\*|^\s*\/\*/, //  comments (including this file's own prose and docs about `title=`)
  /\btitle:\s/, //                object literals (menu items, i18n payloads, macro descriptors)
  /<title\b/, //                  SVG <title> — an accessible name, not a tooltip
  /document\.title/, //           the browser tab title
  /\b(?:frame|iframe)\.title\s*=/, // <iframe title> IS the accessible name (required by a11y)
  /\.title\b\s*(?:\?\?|\|\||\)|,|;|\}|$)/, // READING a .title property (page.title, fence.title, …)
  /\binfo\.title\b/, //           fence info-string metadata (the filename in ```ts title="x")
];

// `.title =` / setAttribute("title" (DOM) — a TOOLTIP, checked per physical line (see ALLOWED_LINE).
const DOM_TITLE_ASSIGN = [
  /\.title\s*=\s*[^=]/,
  /setAttribute\(\s*["']title["']/,
];

// Interactive wrappers — an IconButton/Button/Trigger `title` IS a tooltip and must move to data-tip
// like any other. Every other capitalised component's `title` is a panel/dialog heading prop, not a
// hover bubble, and a native (lowercase) element's `title` is never anything but the banned tooltip.
//
// #1044 review: `DropdownMenuItem` added — it is a thin Radix wrapper that spreads unknown
// props onto its underlying DOM node (`components/ui/dropdown-menu.tsx`), so a `title` prop reaches
// the browser as the banned native tooltip exactly like IconButton's does; it is not a heading prop on
// any DOM the reader can see. The review found a real instance (`OverflowMenu.tsx`'s `hint`), fixed in
// the same change that added this entry — see that file's `data-tip` migration.
const BANNED_TOOLTIP_TAGS = new Set(["IconButton", "Button", "ToggleButton", "DropdownMenuTrigger", "TooltipTrigger", "DropdownMenuItem"]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "__snapshots__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) yield p;
  }
}

// One JSX opening tag at a time, so the `title=` verdict is decided by the tag that actually owns it
// rather than by whichever line it lands on.
//
// #1044 review round 3: TWO hand-rolled scans in a row missed real offenders — round 1's
// `[^>]*` regex stopped at the first `>` anywhere, including one inside an arrow-function prop
// (`onClick={() => copy()}`); round 2's brace/quote-tracking scanner fixed that but then read an
// APOSTROPHE inside a comment or JSX text ("a person's letters") as a string open, and ran to the next
// one — one tag in `settings/AccountPage.tsx` swallowed 527 lines this way, silently skipping every
// real tag nested inside it. A regex (or a hand-rolled quote-tracker) cannot tell a string from a
// comment from JSX text without re-deriving a chunk of the grammar; the real parser already knows.
// `typescript` is an existing devDependency (see `error-is-not-empty-888.test.ts`'s discovery walk for
// the same pattern) — walk `JsxOpeningElement`/`JsxSelfClosingElement` nodes directly, no new
// dependency, no guessing where a tag ends.
function jsxTagOffenders(content: string, fileName: string): { index: number; tag: string }[] {
  const offenders: { index: number; tag: string }[] = [];
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind);

  // A title prop counts as the banned tooltip shape the same way the old regex did: a non-empty string
  // literal, or a `{expr}` whose expression is not itself a JSX element/fragment (title={<Icon/>} is not
  // a shape this codebase uses, but the old pin excluded it explicitly — kept for parity).
  const isTooltipShapedInitializer = (init: ts.JsxAttribute["initializer"]): boolean => {
    if (!init) return false; // bare `title` (no value) — not valid JSX/DOM anyway
    if (ts.isStringLiteral(init)) return init.text.length > 0;
    if (ts.isJsxExpression(init) && init.expression) {
      return !ts.isJsxElement(init.expression) && !ts.isJsxSelfClosingElement(init.expression) && !ts.isJsxFragment(init.expression);
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(source);
      const titleAttr = node.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === "title",
      );
      if (titleAttr && isTooltipShapedInitializer(titleAttr.initializer)) {
        const isBanned = BANNED_TOOLTIP_TAGS.has(tagName);
        if (!(/^[A-Z]/.test(tagName) && !isBanned)) { // exclude: heading-shaped prop on a non-interactive component
          offenders.push({ index: node.getStart(source), tag: node.getText(source).replace(/\s+/g, " ").trim().slice(0, 120) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe("#530: no native `title` tooltips in app code", () => {
  // #892: the case below asserts that the scan found NO offenders, which is also what a scan that ran
  // over nothing reports. Measured on 2026-08-22: pointing the walk at an empty directory left this
  // file green. A pin whose walk has stopped walking reads as coverage while checking nothing.
  it("scanned the source at all", () => {
    const files = [...walk(srcRoot)];
    expect(files.length, `no sources found under ${srcRoot}`).toBeGreaterThanOrEqual(100);
    expect(files.some((f) => f.endsWith("Button.tsx")), "a known source file was not reached").toBe(true);
  });

  it("every tooltip goes through the fast tooltip (Tooltip / data-tip), not the native title", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const content = readFileSync(file, "utf8");
      content.split("\n").forEach((line, i) => {
        if (!DOM_TITLE_ASSIGN.some((re) => re.test(line))) return;
        if (ALLOWED_LINE.some((re) => re.test(line))) return;
        offenders.push(`${relative(srcRoot, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
      for (const { index, tag } of jsxTagOffenders(content, file)) {
        const lineNo = content.slice(0, index).split("\n").length;
        offenders.push(`${relative(srcRoot, file)}:${lineNo}: ${tag.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      }
    }
    expect(
      offenders,
      `native title tooltips found — use <Tooltip content=…> (React) or el.dataset.tip (DOM), or add a REVIEWED exception:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // #1044 break-check: an interactive wrapper's `title` on its OWN line — the exact shape that escaped
  // the old per-line scan — must still be caught.
  it("catches a banned component's title even when the attribute sits alone on its own line", () => {
    const offenders = jsxTagOffenders('<IconButton\n  aria-label="x"\n  title="tooltip"\n  onClick={fn}\n>\n', "t.tsx");
    expect(offenders.length).toBe(1);
  });

  // #1044 review round 2 break-check: an arrow-function prop AHEAD of `title=` — the shape that
  // escaped the round-1 `[^>]*` scan, because its `=>` supplied the first `>` the old regex stopped at.
  it("catches title after an arrow-function prop, on a banned component and a native element alike", () => {
    expect(jsxTagOffenders('<IconButton aria-label="x" onClick={() => copy()} title="Copy">\n', "t.tsx").length).toBe(1);
    expect(jsxTagOffenders('<button onClick={() => go()} title="native">\n', "t.tsx").length).toBe(1);
    // ...and the DropdownMenuItem shape the review found for real (OverflowMenu.tsx), same arrow-prop
    // truncation risk plus the newly-banned tag.
    expect(jsxTagOffenders('<DropdownMenuItem onSelect={() => go()} title={it.hint}>\n', "t.tsx").length).toBe(1);
  });

  // #1044 review round 3 break-check: the exact shape that broke the round-2 hand-scanner — an
  // apostrophe inside a comment (or JSX text) BEFORE the offending tag, which the old quote-tracker read
  // as a string open and ran past every real tag until the next apostrophe. A real parser is immune by
  // construction; this pins that a comment's apostrophe never widens or swallows a tag boundary.
  it("catches a native title after a comment containing an apostrophe (the scanner this replaced could not)", () => {
    const src = [
      "function C() {",
      "  return (",
      "    <div>",
      "      {/* a person's letters, and another's too — plain JSX-text apostrophes, not a string */}",
      '      <button onClick={() => go()} title="native">x</button>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(jsxTagOffenders(src, "t.tsx").length).toBe(1);
  });

  it("does not flag a non-interactive component's heading title, on its own line or the tag's", () => {
    expect(jsxTagOffenders('<Dialog\n  title="Heading"\n>\n', "t.tsx")).toEqual([]);
    expect(jsxTagOffenders("<RelatedSection title={headingText}>\n", "t.tsx")).toEqual([]);
  });
});
