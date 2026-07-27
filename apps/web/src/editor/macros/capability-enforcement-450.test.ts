// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { registerMacro } from "./registry";
import { ALLOWED_CAPABILITIES } from "./macro-registry";
import { html } from "./safe-html";

// #450 / ADR-177 rev2 §4b (user ruling 2026-07-27): capabilities are ENFORCED where a macro is registered,
// not merely disclosed in a manifest a human reviews. ADR-024's narrow host-API is an invariant, and an
// invariant that lives only in review is one until somebody is in a hurry.
const base = (over: Record<string, unknown> = {}) => ({
  kind: "fence" as const,
  lang: `cap450${Math.random().toString(36).slice(2, 8)}`,
  exportFidelity: "degrade" as const,
  htmlRender: () => html`<p>x</p>`,
  liveRender: () => document.createElement("div"),
  summary: () => "x",
  ...over,
});

describe("#450 §4b macro capability enforcement", () => {
  it("the vocabulary is exactly what the host brokers — no aspirational entries", () => {
    expect([...ALLOWED_CAPABILITIES].sort()).toEqual(
      ["design-tokens", "host-list", "render-markdown", "theme"],
    );
    // the two that were listed as "future sandbox surface" with no implementation and no consumer
    expect(ALLOWED_CAPABILITIES.has("net.fetch"), "a capability nobody can be granted is a hole, not a promise").toBe(false);
    expect(ALLOWED_CAPABILITIES.has("storage.local")).toBe(false);
  });

  it("registering a macro that asks for something outside it is refused", () => {
    expect(() => registerMacro(base({ capabilities: ["net.fetch"] }) as never))
      .toThrow(/not brokered by the host/);
    expect(() => registerMacro(base({ capabilities: ["fs.write"] }) as never))
      .toThrow(/not brokered by the host/);
  });

  it("a declared capability from the vocabulary registers fine", () => {
    expect(() => registerMacro(base({ capabilities: ["theme", "render-markdown"] }) as never)).not.toThrow();
  });

  it("declaring no capabilities at all is still fine (first-party default)", () => {
    expect(() => registerMacro(base() as never)).not.toThrow();
  });

  it("a host-resolved list cannot claim to survive export", () => {
    // its content depends on the workspace at read time, so `preserve` would promise a fidelity the macro
    // cannot keep — the Open-formats contract told as a lie (ADR-023).
    expect(() => registerMacro(base({ capabilities: ["host-list"], exportFidelity: "preserve" }) as never))
      .toThrow(/must set exportFidelity/);
    expect(() => registerMacro(base({ capabilities: ["host-list"], exportFidelity: "degrade" }) as never)).not.toThrow();
  });

  it("a malformed capabilities field is refused rather than ignored", () => {
    expect(() => registerMacro(base({ capabilities: "theme" }) as never)).toThrow(/must be an array/);
    expect(() => registerMacro(base({ capabilities: [42] }) as never)).toThrow(/not brokered by the host/);
  });
});
