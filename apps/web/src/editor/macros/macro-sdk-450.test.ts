// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  createMacroSdk, declaredCapabilities, intersectCapabilities, effectiveOf,
  withCallerCapabilities, currentCallerCapabilities, DEFAULT_DECLARED,
} from "./macro-sdk";
import { dispatchMacroRender } from "./md-render";
import type { MacroSource, MacroTheme } from "./registry";

// #450 / ADR-177 slice 5a (user rulings, #450 R2). Three properties, each of which a third-party
// macro would otherwise be able to walk through:
//   1. the SDK is built fresh per dispatch and frozen — a retained reference cannot widen;
//   2. effective = declared ∩ caller — a nested macro never holds more than the one rendering it;
//   3. the host forwards effective through its own re-entries.
// Stage 1 is a design discipline, not a sandbox (same realm), and these pin the discipline.

const theme = { mode: "light" } as unknown as MacroTheme;
const caps = (...c: string[]) => new Set(c);

describe("#450 5a: declared capabilities", () => {
  it("a macro that declares nothing keeps exactly what it receives today", () => {
    expect([...declaredCapabilities({})]).toEqual([...DEFAULT_DECLARED]);
    // MEASURED, not chosen: narrowing this to ["theme"] stopped the first-party containers (none of which
    // declare) from handing their children `renderMarkdown`, which dropped the #215 `data-mac-pos` tags.
    expect([...DEFAULT_DECLARED].sort()).toEqual(["design-tokens", "host-list", "render-markdown", "theme"]);
  });

  it("a declared list outside the vocabulary is dropped rather than trusted", () => {
    // registration already refuses these; a macro object that reached a render without registration
    // must not be handed something the host does not broker.
    expect([...declaredCapabilities({ capabilities: ["theme", "net.fetch"] })]).toEqual(["theme"]);
    // …and a macro that DOES declare gets exactly its list — the ladder rule bites where it is aimed
    expect([...declaredCapabilities({ capabilities: ["host-list"] })]).toEqual(["host-list"]);
  });
});

describe("#450 5a: effective = declared ∩ caller", () => {
  it("a nested macro cannot hold more than its caller", () => {
    const effective = intersectCapabilities(caps("theme", "render-markdown"), caps("theme"));
    expect([...effective]).toEqual(["theme"]);
  });

  it("a container cannot be used as a ladder to something it does not hold", () => {
    const effective = intersectCapabilities(caps("host-list"), caps("theme", "render-markdown"));
    expect([...effective]).toEqual([]);
  });

  it("at the document root there is nothing to intersect with", () => {
    expect([...intersectCapabilities(caps("theme", "host-list"), null)].sort()).toEqual(["host-list", "theme"]);
  });
});

describe("#450 5a: the SDK object itself", () => {
  it("is frozen, so one render cannot widen what another receives", () => {
    const sdk = createMacroSdk({ declared: caps("theme"), caller: null, theme });
    expect(Object.isFrozen(sdk)).toBe(true);
    expect(Object.isFrozen(sdk.capabilities)).toBe(true);
    // a macro trying to grant itself more gets nothing (silently in sloppy mode, throwing in strict)
    try { (sdk as { capabilities: string[] }).capabilities = ["theme", "host-list"]; } catch { /* strict */ }
    expect([...sdk.capabilities]).toEqual(["theme"]);
  });

  it("omits theme when the macro's effective set does not carry it", () => {
    const sdk = createMacroSdk({ declared: caps("host-list"), caller: null, theme });
    expect(sdk.theme).toBeUndefined();
    expect([...sdk.capabilities]).toEqual(["host-list"]);
  });

  it("hands back a NEW object each time — a retained one is a snapshot, not a handle", () => {
    const a = createMacroSdk({ declared: caps("theme"), caller: null, theme });
    const b = createMacroSdk({ declared: caps("theme"), caller: null, theme });
    expect(a).not.toBe(b);
  });
});

describe("#450 5a: the dispatch seam assembles it", () => {
  const macro = (capabilities: string[] | undefined, onRender: (ctx: unknown) => void) => ({
    ...(capabilities ? { capabilities } : {}),
    liveRender: (_b: MacroSource, ctx: unknown) => { onRender(ctx); return document.createElement("div"); },
  });

  it("passes the macro an SDK, not the bare theme object", () => {
    let seen: unknown = null;
    dispatchMacroRender(macro(undefined, (c) => { seen = c; }), "body", { theme });
    expect(Object.isFrozen(seen)).toBe(true);
    expect((seen as { capabilities: string[] }).capabilities).toEqual([...DEFAULT_DECLARED].sort());
    expect((seen as { theme: MacroTheme }).theme).toBe(theme); // …and the existing surface still works
  });

  it("intersects with the CALLER while the host is inside that caller's render", () => {
    let inner: unknown = null;
    const child = macro(["theme", "host-list"], (c) => { inner = c; });
    const parent = {
      capabilities: ["theme"],
      liveRender: (_b: MacroSource) => {
        // the host re-entering its own renderer inside the parent's render — a nested dispatch
        dispatchMacroRender(child, "inner", { theme });
        return document.createElement("div");
      },
    };
    dispatchMacroRender(parent, "outer", { theme });
    expect((inner as { capabilities: string[] }).capabilities, "host-list is not the parent's to give").toEqual(["theme"]);
  });

  it("an explicit caller overrides the ambient one (the root says so)", () => {
    let seen: unknown = null;
    dispatchMacroRender(macro(["theme", "host-list"], (c) => { seen = c; }), "b", { theme, caller: caps("theme") });
    expect((seen as { capabilities: string[] }).capabilities).toEqual(["theme"]);
  });

  it("restores the caller after the render, including when the macro throws", () => {
    const boom = { liveRender: () => { throw new Error("macro blew up"); } };
    withCallerCapabilities(caps("theme"), () => {
      expect(dispatchMacroRender(boom, "b", { theme, onThrow: "null" })).toBeNull();
      expect([...(currentCallerCapabilities() ?? [])], "the caller is not left widened").toEqual(["theme"]);
    });
    expect(currentCallerCapabilities()).toBeNull();
  });

  it("effectiveOf reads back exactly what the SDK carries", () => {
    const sdk = createMacroSdk({ declared: caps("theme", "render-markdown"), caller: null, theme });
    expect([...effectiveOf(sdk)].sort()).toEqual(["render-markdown", "theme"]);
  });
});
