import { describe, it, expect } from "vitest";
import { codeFenceSettings, fenceInfoOf, withFenceInfo } from "./fence-settings";
import { asMacroSource } from "./registry";

// #456 S4: the code fence's declarative settings. What matters here is that configuring by mouse
// produces the same info string a hand-editor would have typed — the standard notation, nothing
// private — and that it never eats an attribute it does not know about.

const info = (s: string) => asMacroSource(s);

describe("#456 S4: code fence settings", () => {
  it("reads the standard info string", () => {
    const v = codeFenceSettings.read(info('ts title="app.ts" showLineNumbers {1,3-5}'));
    expect(v).toEqual({ lang: "ts", title: "app.ts", showLineNumbers: true, highlight: "1,3-5" });
  });

  it("round-trips: what it writes, it reads back", () => {
    const written = codeFenceSettings.write(info("js"), { lang: "python", title: "main.py", showLineNumbers: true, highlight: "2,7-9" });
    expect(codeFenceSettings.read(written)).toEqual({ lang: "python", title: "main.py", showLineNumbers: true, highlight: "2,7-9" });
  });

  it("keeps an attribute it does not know about", () => {
    const written = codeFenceSettings.write(info("ts data-foo=bar"), { lang: "ts", title: "", showLineNumbers: false, highlight: "" });
    expect(written, "someone else's attribute survives a settings write").toContain("data-foo=bar");
  });

  it("clearing a field removes the attribute rather than writing an empty one", () => {
    const written = codeFenceSettings.write(info('ts title="app.ts" showLineNumbers {1}'), { lang: "ts", title: "  ", showLineNumbers: false, highlight: "" });
    expect(written.trim()).toBe("ts");
  });

  it("drops an unparsable highlight instead of guessing", () => {
    const written = codeFenceSettings.write(info("ts"), { lang: "ts", title: "", showLineNumbers: false, highlight: "abc,4-2,0" });
    expect(written).not.toContain("{");
    // …while keeping the valid parts of a mixed input
    const partial = codeFenceSettings.write(info("ts"), { lang: "ts", title: "", showLineNumbers: false, highlight: "abc,3-5" });
    expect(codeFenceSettings.read(partial).highlight).toBe("3-5");
  });

  it("a single line reads and writes as one number, not a degenerate range", () => {
    const written = codeFenceSettings.write(info("ts"), { lang: "ts", title: "", showLineNumbers: false, highlight: "4" });
    expect(written).toContain("{4}");
    expect(codeFenceSettings.read(written).highlight).toBe("4");
  });

  it("the opening-line helpers isolate the info string and put it back", () => {
    expect(fenceInfoOf('```ts title="a.ts"')).toBe('ts title="a.ts"');
    expect(withFenceInfo("```js", info("ts"))).toBe("```ts");
    expect(withFenceInfo("   ~~~~js", info("ts")), "indentation and fence style are preserved").toBe("   ~~~~ts");
    expect(withFenceInfo("not a fence", info("ts")), "a non-fence line is left alone").toBe("not a fence");
  });
});
