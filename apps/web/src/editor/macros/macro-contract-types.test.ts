// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { DirectiveMacro, MacroContext, InnerEditHost, MacroSource } from "./registry";
import { asMacroSource } from "./registry";
import { unsafeHtml } from "./safe-html";

// ADR-045 / #88 (item 3) — MacroSource is a NOMINAL brand: a plain string cannot flow into a
// MacroSource slot at the host↔macro boundary without going through asMacroSource. If the brand is
// removed (MacroSource aliased back to string), the @ts-expect-error stops erroring and typecheck
// fails. A branded value is still usable AS a string (it extends string).
// @ts-expect-error — a raw string is not assignable to MacroSource (must brand via asMacroSource).
const _rawNotSource: MacroSource = "plain string";
const _branded: MacroSource = asMacroSource("branded"); // OK: the one producer
const _sourceIsString: string = _branded; // OK: MacroSource extends string (usable everywhere a string is)

// ADR-045 / #88 (item 4) — TYPE-LEVEL assertions that the macro host-API stays NARROW (ADR-024: a
// macro sees {theme} ONLY; an inline editor sees the small InnerEditHost — never EditorView/
// EditorState/Yjs/session/DB/FGA). If someone widens MacroContext or InnerEditHost (adding, say, a
// `view` field), these Exact<> checks flip to false and typecheck fails — the trust boundary can't
// be quietly broadened. This is the compile-time half of the sandbox boundary the ADR wants locked
// BEFORE user macros (Stage 2). Assertions run when tsc type-checks this file.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A macro's render context is EXACTLY the SDK's surface — no more keys.
// #450 slices 5a/5b widened this from `{theme}` DELIBERATELY, under the rulings on that ticket: the
// context is now the per-dispatch, frozen SDK. Each addition is a brokered host service, none of them
// hands over an editor/CRDT/session handle (the checks below still say so), and every one is absent
// unless the macro's effective capability set carries it. The pin keeps its force: adding a fifth key
// still fails here, which is the point — widening the trust boundary must be a decision, not a diff.
const _ctxKeysExact: Exact<keyof MacroContext, "theme" | "capabilities" | "renderMarkdown" | "instanceKey"> = true;
// The inline-edit host is EXACTLY its narrow surface — theme + the four source/lifecycle methods.
const _hostKeysExact: Exact<keyof InnerEditHost, "theme" | "getSource" | "replaceSource" | "exit" | "beginTextEdit"> = true;
// Neither the context nor the host may expose an editor/CRDT/session handle (spot-check the names a
// widening would most plausibly add — each must be `never`, i.e. absent).
const _noView: Exact<Extract<keyof MacroContext, "view" | "state" | "doc" | "ydoc" | "session">, never> = true;
const _hostNoView: Exact<Extract<keyof InnerEditHost, "view" | "state" | "dispatch" | "ydoc">, never> = true;

// ADR-045 / #88 (item 2) — TYPE-LEVEL anti-tests for the DirectiveMacro discriminated union. These
// assert at COMPILE time (tsc runs over test files) that the container/block exclusivity is enforced
// by the type, not just documented. A `@ts-expect-error` that stops erroring — because someone
// widened the union back to a single loose interface — FAILS typecheck, catching the regression.
// The runtime `expect` below just keeps vitest from seeing an empty suite; the real assertions are
// the type annotations the compiler validates.

const div = () => document.createElement("div");

// VALID: a pure CONTAINER directive (containerClass, optional icon/collapsible, no liveRender).
const container: DirectiveMacro = {
  kind: "directive", name: "vc", exportFidelity: "preserve", htmlRender: () => unsafeHtml(""),
  containerClass: "cm-lp-callout", icon: "info", collapsible: true,
};

// VALID: a pure BLOCK directive (liveRender, optional revealOnCursor, no containerClass).
const block: DirectiveMacro = {
  kind: "directive", name: "vb", exportFidelity: "preserve", htmlRender: () => unsafeHtml(""),
  liveRender: div, revealOnCursor: true,
};

// INVALID: a directive cannot be BOTH a container AND a block — which mode would it render?
// @ts-expect-error — containerClass + liveRender is rejected by the union (ADR-045).
const both: DirectiveMacro = {
  kind: "directive", name: "xb", exportFidelity: "preserve", htmlRender: () => unsafeHtml(""),
  containerClass: "x", liveRender: div,
};

// INVALID: icon is a CONTAINER-only field; it cannot cross onto a block directive.
// @ts-expect-error — icon on a block (liveRender) directive is rejected.
const blockWithIcon: DirectiveMacro = {
  kind: "directive", name: "xi", exportFidelity: "preserve", htmlRender: () => unsafeHtml(""),
  liveRender: div, icon: "info",
};

// INVALID: revealOnCursor is a BLOCK-only field; it cannot cross onto a container directive.
// @ts-expect-error — revealOnCursor on a container (containerClass) directive is rejected.
const containerWithReveal: DirectiveMacro = {
  kind: "directive", name: "xr", exportFidelity: "preserve", htmlRender: () => unsafeHtml(""),
  containerClass: "x", revealOnCursor: true,
};

describe("DirectiveMacro discriminated union (ADR-045 #88 item 2)", () => {
  it("compiles the valid container/block shapes and rejects the invalid ones (see @ts-expect-error)", () => {
    // Reference the bindings so they aren't elided; the assertions that matter ran at compile time.
    expect([container, block, both, blockWithIcon, containerWithReveal].every((m) => m.kind === "directive")).toBe(true);
  });
  it("keeps the macro host-API narrow (MacroContext={theme}, InnerEditHost small) — see Exact<> checks", () => {
    expect([_ctxKeysExact, _hostKeysExact, _noView, _hostNoView].every((v) => v === true)).toBe(true);
  });
  it("brands MacroSource nominally (raw string rejected, branded value is still a string)", () => {
    expect([_rawNotSource, _branded, _sourceIsString].every((v) => typeof v === "string")).toBe(true);
  });
});
