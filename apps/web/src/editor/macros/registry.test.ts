import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames } from "./index"; // importing index registers first-party macros
import { registerMacro, editModeOf } from "./registry";
import { mermaidMacro } from "./mermaid";
import { plantumlMacro } from "./plantuml";
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
    const html = mermaidMacro.htmlRender("<script>alert(1)</script>").toString();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("mermaid summary is a one-line label", () => {
    expect(mermaidMacro.summary("graph TD; A-->B;")).toBe("Mermaid diagram");
  });

  it("registers the plantuml fence macro as degrade-to-source (#140 / ADR-074)", () => {
    const m = findFenceMacro("plantuml");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("fence");
    expect(m!.exportFidelity).toBe("degrade"); // no bundled GPL renderer → degrades to its source
    expect(registeredFenceLangs()).toContain("plantuml");
  });

  it("plantuml htmlRender escapes its body (XSS-safe static export)", () => {
    const html = plantumlMacro.htmlRender("<script>alert(1)</script>").toString();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("registers the first-party callout directive macros (#150 typed)", () => {
    const m = findDirectiveMacro("warning");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("directive");
    expect(m!.containerClass).toBe("cm-lp-callout cm-lp-callout-warning");
    expect(m!.icon).toBe("triangle-alert"); // #158-C4: Lucide icon NAME (rendered as a mask-image)
    expect(findDirectiveMacro("note")!.icon).toBe("pencil"); // note now carries an icon too (C4)
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
    expect(noteCalloutMacro.htmlRender("<img src=x onerror=1>").toString()).not.toContain("<img");
  });
});

// ADR-045 / #88 item 5 — registerMacro's RUNTIME fortress for registrations that reach the registry
// with the types bypassed (a JS caller / future untrusted descriptor). Each malformed shape must
// throw a DISTINCT, descriptive error at register time — not shadow, not render the wrong mode, not
// fail silently later. Cast through `any` on purpose: these inputs are exactly the ones the compiler
// would reject, and we are asserting the runtime catches them too.
describe("registerMacro runtime validation (ADR-045 #88 item 5)", () => {
  const base = { exportFidelity: "preserve", htmlRender: () => "" };
  it("rejects an invalid directive name (spaces/colons/empty never match the parser)", () => {
    expect(() => registerMacro({ kind: "directive", name: "has space", containerClass: "x", ...base } as any)).toThrow(/invalid directive macro name/);
    expect(() => registerMacro({ kind: "directive", name: "", containerClass: "x", ...base } as any)).toThrow(/invalid directive macro name/);
  });
  it("rejects an invalid fence lang", () => {
    expect(() => registerMacro({ kind: "fence", lang: "c++ x", liveRender: () => document.createElement("div"), summary: () => "", ...base } as any)).toThrow(/invalid fence macro lang/);
  });
  it("rejects a directive that declares BOTH containerClass and liveRender (ambiguous mode)", () => {
    expect(() => registerMacro({ kind: "directive", name: "bothmodes", containerClass: "x", liveRender: () => document.createElement("div"), ...base } as any)).toThrow(/BOTH containerClass and liveRender/);
  });
  it("rejects a directive that declares NEITHER render mode", () => {
    expect(() => registerMacro({ kind: "directive", name: "nomode", ...base } as any)).toThrow(/neither containerClass nor liveRender/);
  });
  it("rejects a bad exportFidelity", () => {
    expect(() => registerMacro({ kind: "directive", name: "badfidelity", containerClass: "x", htmlRender: () => "", exportFidelity: "lossy" } as any)).toThrow(/exportFidelity/);
  });
  it("rejects a fence macro missing summary / liveRender", () => {
    expect(() => registerMacro({ kind: "fence", lang: "nosummary", liveRender: () => document.createElement("div"), ...base } as any)).toThrow(/must define summary/);
    expect(() => registerMacro({ kind: "fence", lang: "norender", summary: () => "", ...base } as any)).toThrow(/must define liveRender/);
  });
  it("rejects a richEditUI with a bad present / missing editor.mount", () => {
    expect(() => registerMacro({ kind: "directive", name: "badrich", containerClass: "x", ...base, richEditUI: { present: "popup", editor: {} } } as any)).toThrow(/richEditUI\.present/);
    expect(() => registerMacro({ kind: "directive", name: "badrich2", containerClass: "x", ...base, richEditUI: { present: "modal", editor: {} } } as any)).toThrow(/richEditUI\.editor/);
  });
  it("rejects an unknown kind", () => {
    expect(() => registerMacro({ kind: "widget", name: "x", ...base } as any)).toThrow(/kind must be/);
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

describe("editModeOf (#174 / ADR-087 — mouse-edit interaction)", () => {
  it("derives 'modal' from a modal richEditUI (Excalidraw) with no explicit editMode", () => {
    const ex = findFenceMacro("excalidraw");
    expect(ex).toBeDefined();
    expect(ex!.richEditUI?.present).toBe("modal");
    expect(ex!.editMode).toBeUndefined();
    expect(editModeOf(ex!)).toBe("modal");
  });

  it("derives 'inline' for macros edited in place (mermaid fence, note callout, table)", () => {
    expect(editModeOf(mermaidMacro)).toBe("inline"); // no richEditUI → edited by entering the source
    expect(editModeOf(noteCalloutMacro)).toBe("inline"); // inline richEditUI panel
    expect(editModeOf(findDirectiveMacro("table")!)).toBe("inline"); // in-editor table ops
  });

  it("lets an explicit editMode override the richEditUI-derived default", () => {
    expect(editModeOf({ editMode: "modal", richEditUI: undefined })).toBe("modal");
    expect(editModeOf({ editMode: "inline", richEditUI: { present: "modal" } as never })).toBe("inline");
  });
});
