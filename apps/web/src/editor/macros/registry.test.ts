import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames } from "./index"; // importing index registers first-party macros
import { registerMacro, editModeOf, hasEditUI, type EditUI } from "./registry";
import { mermaidMacro } from "./mermaid";
import { plantumlMacro } from "./plantuml";
import { noteCalloutMacro } from "./callout";
import { fenceLang, fenceBody } from "./fence";

// #174 / ADR-087: the unified editUI contract must drive the interaction matrix (editModeOf) and the
// edit-button predicate (hasEditUI), migration-safe alongside the legacy richEditUI.
describe("editUI unification (#174 / ADR-087)", () => {
  const noopEditUI = (present: "inline" | "modal"): EditUI => ({ present, mount: () => ({ destroy() {} }) });

  it("editModeOf: editUI.present takes precedence over the legacy richEditUI", () => {
    // editUI wins even when a legacy modal richEditUI would otherwise say "modal"
    expect(editModeOf({ editUI: noopEditUI("inline"), richEditUI: { present: "modal", editor: {} as never } })).toBe("inline");
    expect(editModeOf({ editUI: noopEditUI("modal") })).toBe("modal");
  });

  it("editModeOf: falls back to richEditUI, then inline (editMode attribute folded into editUI, ADR-087)", () => {
    expect(editModeOf({ richEditUI: { present: "modal", editor: {} as never } })).toBe("modal");
    expect(editModeOf({ richEditUI: { present: "inline", editor: {} as never } })).toBe("inline");
    expect(editModeOf({})).toBe("inline");
  });

  it("hasEditUI: true for either the unified editUI or the legacy richEditUI, false otherwise", () => {
    expect(hasEditUI({ editUI: noopEditUI("inline") })).toBe(true);
    expect(hasEditUI({ richEditUI: { present: "inline", editor: {} as never } })).toBe(true);
    expect(hasEditUI({})).toBe(false); // a plain macro (no rich edit) gets no edit button
  });
});

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

  // #307 / ADR-127: the :::backlinks directive macro is host-mediated — export DEGRADES (the list is derived,
  // not content) and its web htmlRender is a type-contract stub (empty; the server export doesn't register it).
  // The liveRender placeholder + the host resolve/collapse behaviour are exercised in the real-browser e2e
  // (this suite runs in node — no DOM — so it checks the declarative contract only).
  it("registers the :::backlinks directive macro as degrade with an empty htmlRender stub", () => {
    const m = findDirectiveMacro("backlinks");
    expect(m).toBeTruthy();
    expect(m!.exportFidelity).toBe("degrade");
    expect(registeredDirectiveNames()).toContain("backlinks");
    expect(m!.htmlRender && m!.htmlRender("").toString()).toBe(""); // empty output — export emits nothing
  });

  // #324 / ADR-134: :::query — same host-mediated contract as :::backlinks (degrade, empty htmlRender stub;
  // the server export doesn't register it, so off-platform it emits nothing). The member-live resolve/collapse
  // is exercised in e2e.
  it("registers the :::query directive macro as degrade with an empty htmlRender stub", () => {
    const m = findDirectiveMacro("query");
    expect(m).toBeTruthy();
    expect(m!.exportFidelity).toBe("degrade");
    expect(m!.revealOnCursor).toBe(true);
    expect(registeredDirectiveNames()).toContain("query");
    expect(m!.htmlRender && m!.htmlRender("").toString()).toBe(""); // empty output — export emits nothing
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
  it("derives 'modal' from a modal richEditUI (Excalidraw)", () => {
    const ex = findFenceMacro("excalidraw");
    expect(ex).toBeDefined();
    expect(ex!.richEditUI?.present).toBe("modal");
    expect(editModeOf(ex!)).toBe("modal");
  });

  it("derives 'inline' for macros edited in place (mermaid editUI, note callout editUI, table richEditUI)", () => {
    expect(editModeOf(mermaidMacro)).toBe("inline"); // editUI.present inline (slice 4b)
    expect(editModeOf(noteCalloutMacro)).toBe("inline"); // editUI.present inline (slice 4b)
    expect(editModeOf(findDirectiveMacro("table")!)).toBe("inline"); // in-editor table ops (richEditUI inline)
  });
});
