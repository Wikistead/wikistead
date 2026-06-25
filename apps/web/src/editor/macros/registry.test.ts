import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames } from "./index"; // importing index registers first-party macros
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";
import { calloutMacro } from "./callout";
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

  it("registers the first-party callout directive macro", () => {
    const m = findDirectiveMacro("callout");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("directive");
    expect(m!.containerClass).toBe("cm-lp-callout");
    expect(m!.exportFidelity).toBe("preserve"); // ::: stays plain text → round-trips
    expect(registeredDirectiveNames()).toContain("callout");
    expect(findDirectiveMacro("CALLOUT")).toBe(m); // case-insensitive
    expect(findDirectiveMacro("nope")).toBeUndefined();
  });

  it("rejects a duplicate directive registration", () => {
    expect(() => registerMacro(calloutMacro)).toThrow(/duplicate/);
  });

  it("callout htmlRender escapes its body (XSS-safe wrapper)", () => {
    expect(calloutMacro.htmlRender("<img src=x onerror=1>")).not.toContain("<img");
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
