import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
import { FormRow } from "./FormRow";

// #535: a form row holding a Select, an Input and a Button came out ragged — 34 / 38 / 28 px — because
// the Button sized itself from its padding while the other two declare a height. The fix belongs in the
// design system (one height per size variant, shared), not in per-row px nudges that the next screen would
// have to rediscover. This pins the agreement between the three at the source, so a future edit that gives
// one of them its own height fails here rather than in someone's screenshot.
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("#535 the controls that share a row share a height", () => {
  const button = read("ui/Button.tsx");
  const input = read("components/ui/input.tsx");
  const select = read("components/ui/select.tsx");
  const inputWrap = read("ui/Input.tsx");

  it("the shared Button declares a height per size (it used to derive one from padding)", () => {
    expect(button, "md is the default control height").toMatch(/md:\s*"h-9/);
    expect(button, "sm is the compact control height").toMatch(/sm:\s*"h-8/);
  });

  it("…and those are the SAME heights Select and Input use", () => {
    expect(select, "select: default/sm").toContain("data-[size=default]:h-9");
    expect(select).toContain("data-[size=sm]:h-8");
    expect(input, "input base is the default height").toMatch(/"h-9 w-full/);
    expect(inputWrap, "and its compact variant is the compact height").toMatch(/scale === "sm" && "h-8/);
  });
});

// #535 (second round): agreeing SIZE VARIANTS were never the problem — the DS already had those. Rows came
// out ragged because each control's scale was a separate decision at each call site, and the Input's prop
// is spelled differently and defaults the other way, so it was the one everybody forgot. Seven rows across
// six files were ragged that way; the previous fix named two of them and the eighth arrived three minutes
// after review. A row now declares the scale once and the controls inside read it.
//
// (createElement, not JSX, so this stays a .test.ts the web vitest config already picks up.)
const inRow = (child: unknown) => renderToStaticMarkup(createElement(FormRow, null, child as never));

describe("#535 a FormRow puts its controls on one scale", () => {
  it("a Button with no size takes the row's compact scale", () => {
    expect(inRow(createElement(Button, null, "x"))).toContain("h-8");
    expect(inRow(createElement(Button, null, "x"))).not.toContain("h-9");
  });

  it("an Input with no inputSize takes it too — the one every ragged row got wrong", () => {
    expect(inRow(createElement(Input, {}))).toContain("h-8");
  });

  it("an IconButton matches the row rather than staying square at its own size", () => {
    expect(inRow(createElement(IconButton, { "aria-label": "x" }))).toContain("size-8");
    const md = renderToStaticMarkup(createElement(FormRow, { scale: "md" as const }, createElement(IconButton, { "aria-label": "x" })));
    expect(md, "a md row scales it up with everything else").toContain("size-9");
  });

  it("an explicit size still wins over the row", () => {
    const html = renderToStaticMarkup(createElement(FormRow, null, createElement(Button, { size: "md" as const }, "x")));
    expect(html).toContain("h-9");
  });

  it("OUTSIDE a row nothing moved: the old defaults are byte-for-byte what they were", () => {
    // This is the non-regression that matters — these controls are everywhere, and the row context must
    // be inert outside a row or the whole app shifts by 4px.
    expect(renderToStaticMarkup(createElement(Button, null, "x")), "Button default is still md").toContain("h-9");
    expect(renderToStaticMarkup(createElement(Input, {})), "Input default is still md").not.toContain("h-8");
    expect(renderToStaticMarkup(createElement(IconButton, { "aria-label": "x" })), "IconButton is still 32px square").toContain("size-8");
  });
});
