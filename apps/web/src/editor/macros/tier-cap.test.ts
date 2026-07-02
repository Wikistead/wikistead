// Macro level-cap demote logic (#93 / ADR-073) — pure (no DOM). Verifies the "min(lowest-
// representable, cap)" rule + the normalize-not-reject default when nothing within the cap can
// represent the source.
import { describe, it, expect } from "vitest";
import { targetCapLevel, demoteToCapLevel } from "./tier-cap";
import type { MacroTier, MacroLevel, MacroSource } from "./registry";
import { asMacroSource } from "./registry";

const S = asMacroSource; // brand a source-string literal at the host↔macro boundary (ADR-045 #88)
const L = (id: string, layer: MacroLevel["layer"]): MacroLevel => ({ id, layer });
// Fake 3-level tier (lowest → highest): commonmark < gfm < directive. toLevel tags the level id.
const mk = (canAt: (source: MacroSource, level: MacroLevel) => boolean): MacroTier => ({
  levels: [L("cm", "commonmark"), L("pipe", "gfm"), L("html", "directive")],
  canRepresentAt: canAt,
  toLevel: (source, level) => asMacroSource(`${level.id}:${source}`),
});

describe("targetCapLevel / demoteToCapLevel (#93 / ADR-073)", () => {
  it("cap=directive: the LOWEST representable level wins (Open formats)", () => {
    const tier = mk((_s, l) => l.id !== "cm"); // representable at gfm + directive
    expect(targetCapLevel(tier, S("x"), "directive")?.id).toBe("pipe");
  });

  it("cap=gfm clamps the ceiling: directive is excluded; lowest representable within gfm", () => {
    const tier = mk((_s, l) => l.layer !== "commonmark"); // gfm + directive representable
    expect(targetCapLevel(tier, S("x"), "gfm")?.id).toBe("pipe"); // not html (over cap)
  });

  it("cap=gfm but only directive can represent → highest within cap (lossy NORMALIZE, not reject)", () => {
    const tier = mk((_s, l) => l.layer === "directive");
    expect(targetCapLevel(tier, S("x"), "gfm")?.id).toBe("pipe"); // none representable within gfm → highest within cap
    expect(demoteToCapLevel(tier, S("merged"), "gfm")).toBe("pipe:merged"); // normalized down, not rejected
  });

  it("cap=commonmark with nothing representable → commonmark (the only level within the cap)", () => {
    expect(targetCapLevel(mk(() => false), S("x"), "commonmark")?.id).toBe("cm");
  });

  it("demoteToCapLevel rewrites via toLevel; cap=directive keeps the lowest representable", () => {
    const tier = mk((_s, l) => l.id !== "cm");
    expect(demoteToCapLevel(tier, S("body"), "directive")).toBe("pipe:body");
  });
});
