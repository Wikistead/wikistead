import { describe, it, expect } from "vitest";
import { themeAdaptStrokes } from "./excalidraw";

// #200: default strokes must follow the DISPLAY theme (Excalidraw stores absolute colours, so a
// default stroke drawn in one theme is stranded after a switch). themeAdaptStrokes remaps ONLY the
// known defaults to the current theme's default; user-picked colours are left as-is.
describe("themeAdaptStrokes (#200)", () => {
  it("remaps a light-default stroke (#1e1e1e) to the dark default when displaying dark", () => {
    const [e] = themeAdaptStrokes([{ id: "a", strokeColor: "#1e1e1e" }], true);
    expect(e.strokeColor).toBe("#e3e3e8");
  });

  it("remaps a dark-default stroke (#e3e3e8) to the light default when displaying light", () => {
    const [e] = themeAdaptStrokes([{ id: "a", strokeColor: "#e3e3e8" }], false);
    expect(e.strokeColor).toBe("#1e1e1e");
  });

  it("leaves a user-picked colour untouched in either theme", () => {
    expect(themeAdaptStrokes([{ id: "a", strokeColor: "#e03131" }], true)[0].strokeColor).toBe("#e03131");
    expect(themeAdaptStrokes([{ id: "a", strokeColor: "#e03131" }], false)[0].strokeColor).toBe("#e03131");
  });

  it("is a no-op when the default already matches the theme (no needless object churn)", () => {
    const els = [{ id: "a", strokeColor: "#1e1e1e" }];
    const out = themeAdaptStrokes(els, false); // light default, light theme → unchanged
    expect(out[0]).toBe(els[0]); // same reference (not cloned)
  });

  it("is case-insensitive and ignores elements without a string strokeColor", () => {
    expect(themeAdaptStrokes([{ id: "a", strokeColor: "#1E1E1E" }], true)[0].strokeColor).toBe("#e3e3e8");
    expect(themeAdaptStrokes([{ id: "a" }], true)[0]).toEqual({ id: "a" }); // no strokeColor → untouched
  });
});
