// #632 (user ruling): every macro that draws a coloured left bar must draw it as a STRIP, not as
// a border.
//
// A `border-left` follows the box's corner radius. Against a rounded edge it curves inward at both ends
// — the the ruling names — and the fix is NOT to square the corners ("
// bar becomes a rectangle that ignores it.
//
// The list of macros comes from the REGISTRY. caught this exact ticket shipping a fix that reached
// one callout and missed `:::todo`, because the earlier sweep was a grep over CSS rules — which cannot
// see a look assembled from several rules — and the earlier pin only ever rendered one macro. The tenth
// container macro written next month is covered here the day it registers.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "./index"; // the registrations happen as a side effect of this module
import { registeredDirectiveNames, findDirectiveMacro } from "./registry";

/** Every registered macro that renders as a tinted container (the ones that can carry a bar). */
function containerMacros(): { name: string; containerClass: string }[] {
  const out: { name: string; containerClass: string }[] = [];
  for (const name of registeredDirectiveNames()) {
    const cls = findDirectiveMacro(name)?.containerClass;
    if (cls) out.push({ name, containerClass: cls });
  }
  return out;
}

const css = () => readFileSync(resolve(import.meta.dirname, "../../styles/callout-icons.css"), "utf8");
const baseTheme = () => readFileSync(resolve(import.meta.dirname, "../live-preview/decorations.ts"), "utf8");

describe("#632: a container macro's left bar is a strip, not a border", () => {
  it("the registry actually yields container macros (a broken query must not pass vacuously)", () => {
    const found = containerMacros();
    expect(found.length, `container macros: ${found.map((m) => m.name).join(", ")}`).toBeGreaterThanOrEqual(3);
    // the two the ruling named, so a registry that silently stopped listing them fails here
    expect(found.map((m) => m.name)).toContain("todo");
    expect(found.some((m) => m.containerClass.includes("cm-lp-callout"))).toBe(true);
  });

  // NOT asserted here: "no container uses border-left". Measured, that flags `:::details`, whose bar is
  // a border AND whose box has no radius — so it does not bend, and squaring it would change nothing a
  // reader can see. Whether a bar bends is the product of two rules that a source scan cannot join;
  // that is the same blindness caught in the original sweep. The bend itself is measured in the
  // real DOM by `straight-left-bar-632.spec.ts`, which renders every macro this query returns.

  it("…and the bar it draws instead is painted as part of the box", () => {
    const sources = [css(), baseTheme()].join("\n");
    // The bar still existing is what makes the previous assertion mean something: without it, deleting
    // the border would satisfy that test by removing the bar entirely, which the ruling refused outright
    //
    // #632 it is a BACKGROUND BAND now, not an absolutely-positioned child. A child could not be
    // clipped by the box's corners — given `border-radius: inherit` its radius was clamped to half its
    // own 3px width, so the left corner came out squarer than the right. A background is clipped by the
    // radius whatever it says, so both corners take the same arc.
    expect(sources, "a hard-edged band at the left of the box").toMatch(/linear-gradient\(\s*to right/);
    expect(sources, "…sized from the shared token, not from a literal").toMatch(/to right[^;]*--wks-bar-w/);
  });

  it("the space the border occupied is given back, so nothing inside moves", () => {
    // Removing a 3px border shrinks the content box by 3px and slides the icon. The ruling's standing
    // condition across every revision of this ticket is that the icon does not move.
    //
    // Three surfaces draw this bar, and the first attempt gave the width back in two of them — the
    // panel and the notice boxes — leaving `:::todo`'s icon 3px adrift. So the width is one
    // token and both halves of every site read it: the strip's own width, and the padding that clears
    // it. Whether each site actually MOVED with the token is measured in the real DOM by
    // `straight-left-bar-632.spec.ts`, which widens it and watches the content follow — a source scan
    // cannot tell a padding that merely mentions the token from one that is derived from it.
    // Deliberately NOT written as "for each strip found, …": both files carry several `::before` rules
    // that are not bars (the callout icon, the code-fence label), and a scan that tries to tell them
    // apart by their declarations picks up whichever one it reaches first. What is worth asserting from
    // the source is the pairing itself — a file that draws a bar also reserves room for it.
    for (const [where, text] of [["the shared stylesheet", css()], ["the editor's baseTheme", baseTheme()]] as const) {
      expect(text, `${where}: the bar's width comes from the token`).toMatch(/--wks-bar-w[^;]*\)|width:\s*"?var\(--wks-bar-w/);
      expect(text, `${where}: and the padding beside it reserves that same width`).toMatch(/padding[^;{}]*--wks-bar-w/);
    }
  });
});
