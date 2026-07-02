// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import type { DirectiveMacro } from "./registry";
import { unsafeHtml } from "./safe-html";

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
});
