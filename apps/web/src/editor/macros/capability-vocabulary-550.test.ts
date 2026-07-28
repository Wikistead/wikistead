// @vitest-environment happy-dom
// #550 review follow-up: the capability vocabulary's one deliberate asymmetry, pinned so it stays a
// DECISION instead of drifting into an accident.
//
//   - `host-embed` is in DEFAULT_DECLARED: a first-party (undeclared) macro — embed-external — asks
//     the host for an allowlist-checked iframe slot.
//   - It is NOT in macro-registry's ALLOWED_CAPABILITIES: a DECLARING (marketplace-shaped) macro
//     cannot obtain it. Whether third parties may ask the host for iframes at all is a trust-boundary
//     ruling still owed (#550 review, finding 1); until it is made, "declared macros get nothing new"
//     is the fail-closed state and this file is what keeps it deliberate.
//
// Also pinned here: the per-kind slot gate itself (the #550 commit's central claim — holding
// host-list does not open the embed kind, and vice versa) and the embed slot's url-shape check.
import { describe, it, expect } from "vitest";
import { DEFAULT_DECLARED, createMacroSdk, declaredCapabilities, type HostSlotParams } from "./macro-sdk";
import { ALLOWED_CAPABILITIES } from "./macro-registry";

const theme = {} as never;
const slotSpy = () => {
  const calls: HostSlotParams[] = [];
  return { calls, factory: (p: HostSlotParams) => { calls.push(p); return document.createElement("div"); } };
};

describe("#550: the vocabulary split is exactly {host-embed}, by decision", () => {
  it("DEFAULT_DECLARED minus ALLOWED_CAPABILITIES === {host-embed} — nothing else may drift out", () => {
    const outside = [...DEFAULT_DECLARED].filter((c) => !ALLOWED_CAPABILITIES.has(c));
    expect(outside).toEqual(["host-embed"]);
  });
  it("a DECLARING macro asking for host-embed silently gets nothing (fail-closed until the ruling)", () => {
    expect([...declaredCapabilities({ capabilities: ["host-embed", "theme"] })]).toEqual(["theme"]);
  });
});

describe("#550: the per-kind slot gate", () => {
  it("holding host-list does NOT open the embed kind", () => {
    const { calls, factory } = slotSpy();
    const sdk = createMacroSdk({ declared: new Set(["host-list"]), caller: null, theme, hostSlot: factory });
    expect(() => sdk.hostSlot!({ kind: "embed", url: "https://x.example/" })).toThrow(/capability not held/);
    expect(calls, "the host factory never ran").toHaveLength(0);
  });
  it("holding host-embed does NOT open the list kind", () => {
    const { calls, factory } = slotSpy();
    const sdk = createMacroSdk({ declared: new Set(["host-embed"]), caller: null, theme, hostSlot: factory });
    expect(() => sdk.hostSlot!({ kind: "list", source: "tagged" })).toThrow(/capability not held/);
    expect(calls).toHaveLength(0);
  });
  it("the held kind passes through to the host factory", () => {
    const { calls, factory } = slotSpy();
    const sdk = createMacroSdk({ declared: new Set(["host-embed"]), caller: null, theme, hostSlot: factory });
    expect(sdk.hostSlot!({ kind: "embed", url: "https://x.example/" })).toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});

describe("#550: the embed slot refuses a non-string url (R3: values only, host-validated)", () => {
  it("dispatch answers null-render, never a TypeError reaching the surface", async () => {
    const { dispatchMacroRender, withEmbedHost } = await import("./md-render");
    const el = withEmbedHost({ build: () => document.createElement("iframe") }, () =>
      dispatchMacroRender(
        {
          capabilities: ["host-embed"],
          liveRender: (_b: string, ctx: { hostSlot?: unknown }) => {
            // deliberately malformed — the host must refuse the shape, not interpret it
            const r = (ctx.hostSlot as unknown as (p: unknown) => HTMLElement | null)({ kind: "embed", url: 42 });
            if (r) return r;
            const d = document.createElement("div");
            d.textContent = "placeholder";
            return d;
          },
        } as never,
        "body",
        { theme },
      ),
    );
    // the malformed ask threw inside the host ("unsupported request"), the dispatch caught it → null
    expect(el).toBeNull();
  });
});
