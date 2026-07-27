import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(inputWrap, "and its compact variant is the compact height").toMatch(/inputSize === "sm" && "h-8/);
  });
});
