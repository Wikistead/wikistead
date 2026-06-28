import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames } from "./index"; // importing index registers first-party macros
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";
import { noteCalloutMacro } from "./callout";
import { fenceLang, fenceBody } from "./fence";

describe("macro registry", () => {
  it("registers the first-party mermaid fence macro", () => {
    const m = findFenceMacro("mermaid");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("fence");
    expect(m!.exportFidelity).toBe("preserve"); // required, declarative body round-trips
    expect(registeredFenceLangs()).toContain("mermaid");
  });

  it("looks up case-insensitively and misses unknown langs", () => {
    expect(findFenceMacro("MERMAID")).toBe(findFenceMacro("mermaid"));
    expect(findFenceMacro("nope")).toBeUndefined();
  });

  it("rejects a duplicate fence-language registration (fail loud, no silent shadow)", () => {
    expect(() => registerMacro(mermaidMacro)).toThrow(/duplicate/);
  });

  it("mermaid htmlRender escapes its body (XSS-safe static export)", () => {
    const html = mermaidMacro.htmlRender("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("mermaid summary is a one-line label", () => {
    expect(mermaidMacro.summary("graph TD; A-->B;")).toBe("Mermaid diagram");
  });

  it("registers the first-party callout directive macros (#150 typed)", () => {
    const m = findDirectiveMacro("warning");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("directive");
    expect(m!.containerClass).toBe("cm-lp-callout cm-lp-callout-warning");
    expect(m!.icon).toBe("⚠️"); // typed variants carry a header icon (note has none)
    expect(m!.exportFidelity).toBe("preserve"); // ::: stays plain text → round-trips
    expect(registeredDirectiveNames()).toContain("warning");
    expect(findDirectiveMacro("WARNING")).toBe(m); // case-insensitive
    expect(findDirectiveMacro("nope")).toBeUndefined();
  });

  it("registers the excalidraw fence macro with a modal richEditUI", () => {
    const m = findFenceMacro("excalidraw");
    expect(m).toBeDefined();
    expect(m!.exportFidelity).toBe("preserve");
    expect(m!.richEditUI?.present).toBe("modal"); // mouse edit = modal (React out of CM)
  });

  it("rejects a duplicate directive registration", () => {
    expect(() => registerMacro(noteCalloutMacro)).toThrow(/duplicate/);
  });

  it("registers the typed callout variants (#150)", () => {
    for (const t of ["note", "info", "tip", "warning", "danger"]) expect(registeredDirectiveNames()).toContain(t);
  });

  it("callout htmlRender escapes its body (XSS-safe wrapper)", () => {
    expect(noteCalloutMacro.htmlRender("<img src=x onerror=1>")).not.toContain("<img");
  });
});

describe("fence parsing", () => {
  it("reads the info string (lang) from the opening fence", () => {
    expect(fenceLang("```mermaid")).toBe("mermaid");
    expect(fenceLang("   ~~~ js")).toBe("js");
    expect(fenceLang("```")).toBeNull(); // no lang
    expect(fenceLang("not a fence")).toBeNull();
  });

  it("extracts the body between the fences, excluding fence lines", () => {
    const doc = Text.of(["```mermaid", "graph TD;", "A-->B;", "```"]);
    expect(fenceBody(doc, 0, doc.length)).toBe("graph TD;\nA-->B;");
  });
});
