import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #1170: the callout (and #456 S3 details/summary) body field looked uneditable in the shipped path.
// `.cm-lp-callout-edit-body`'s border/background/min-height only ever matched the plain <textarea> a
// host without `editEnv.mountSurface` falls back to — which is, in practice, only the unit tests
// (callout-editui.test.ts mounts without an editEnv). The real body editor is a nested CM island
// (`mountSourceEditor`, whose own `slotIslandTheme` deliberately makes it transparent/borderless — see
// that theme's own comment — expecting a wrapper to supply the box), so the shipped Content field had
// no visible edit surface at all next to a boxed Type row and Header input.
//
// This can't be pinned by rendering the real nested CM instance in jsdom/happy-dom (the existing suite
// has no fixture that stands one up for this panel), so it reads the style table as text, the same way
// tokens.css's `--font` chain is pinned elsewhere in this codebase — a wiring pin, not a rendering one.
const DECORATIONS = readFileSync(
  resolve(import.meta.dirname, "decorations.ts"),
  "utf8",
);

describe("#1170: the callout/details body field is boxed whichever surface fills it", () => {
  it("a rule reaches a nested CM island inside the shared body-field wrapper, not only the textarea", () => {
    // `.cm-lp-callout-edit-field` wraps exactly one field (caption + control) in both callout.ts and
    // layout-directives.ts, and only a BODY field ever mounts a `.cm-editor` inside it (Type is
    // buttons, Header/Summary is a plain <input>) — so this selector reaches the island without a new
    // class on either macro file.
    expect(DECORATIONS, "no rule targets a nested CM island under the shared field wrapper")
      .toMatch(/"\.cm-lp-callout-edit-field \.cm-editor":\s*\{[^}]*\}/);
  });

  it("that rule carries the same box treatment the textarea fallback already has", () => {
    const rule = DECORATIONS.match(/"\.cm-lp-callout-edit-field \.cm-editor":\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule, "island rule not found").not.toBe("");
    for (const prop of ["border:", "borderRadius:", "background:", "minHeight:"]) {
      expect(rule, `island rule missing ${prop}: ${rule}`).toContain(prop);
    }
  });

  it("the textarea fallback (unit-test-only path) keeps its own box rule unchanged", () => {
    // Not touched by #1170 — still what callout-editui.test.ts's fallback-path assertions measure.
    expect(DECORATIONS).toMatch(/"\.cm-lp-callout-edit-body":\s*\{[^}]*border:[^}]*\}/);
  });

  it("both call sites share the wrapper class this rule depends on", () => {
    const callout = readFileSync(resolve(import.meta.dirname, "..", "macros", "callout.ts"), "utf8");
    const layoutDirectives = readFileSync(resolve(import.meta.dirname, "..", "macros", "layout-directives.ts"), "utf8");
    for (const [name, src] of [["callout.ts", callout], ["layout-directives.ts", layoutDirectives]] as const) {
      expect(src, `${name}: body field is not built by the shared field() helper (cm-lp-callout-edit-field)`)
        .toContain('f.className = "cm-lp-callout-edit-field"');
      expect(src, `${name}: still mounts a surface into the body field`).toContain("mountSurface");
    }
  });
});
