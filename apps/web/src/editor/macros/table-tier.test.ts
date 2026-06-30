import { describe, it, expect } from "vitest";
import { tableTier } from "./table";
import { applyTier } from "../live-preview/macro-edit";
import { demoteToCapLevel } from "./tier-cap";

// ADR-025 step 3: the table MacroTier (pipe ⟷ :::table) + the host's auto-demote (applyTier).
// The tier IS the promote/demote rule, now declared as data the host applies — the editor
// hands over a lossless :::table source and the host levels it.

const SIMPLE_PIPE = "| A | B |\n| --- | --- |\n| 1 | 2 |";
const MERGED = ':::table\n<table><tr><td colspan="2">X</td></tr><tr><td>a</td><td>b</td></tr></table>\n:::';
const STYLED = ':::table\n<table><tr><td style="background:#fee">x</td><td>y</td></tr></table>\n:::';

const [PIPE, HTML] = tableTier.levels;

describe("tableTier", () => {
  it("orders levels lowest (gfm pipe) → highest (directive html)", () => {
    expect(PIPE).toMatchObject({ id: "pipe", layer: "gfm" });
    expect(HTML).toMatchObject({ id: "html", layer: "directive" });
  });

  it("canRepresentAt: a span/style-free grid is pipe-representable; merged/styled is not", () => {
    expect(tableTier.canRepresentAt(SIMPLE_PIPE, PIPE!)).toBe(true);
    expect(tableTier.canRepresentAt(MERGED, PIPE!)).toBe(false); // colspan can't be a pipe table
    expect(tableTier.canRepresentAt(STYLED, PIPE!)).toBe(false); // per-cell style can't be a pipe table
    // HTML can express anything
    expect(tableTier.canRepresentAt(SIMPLE_PIPE, HTML!)).toBe(true);
    expect(tableTier.canRepresentAt(MERGED, HTML!)).toBe(true);
  });

  it("toLevel: converts a source to the requested level", () => {
    // a merged :::table source asked for HTML round-trips its colspan
    expect(tableTier.toLevel(MERGED, HTML!)).toContain('colspan="2"');
    expect(tableTier.toLevel(MERGED, HTML!).startsWith(":::table")).toBe(true);
    // a simple source asked for pipe is a GFM pipe table (no :::table wrapper)
    const pipe = tableTier.toLevel(SIMPLE_PIPE, PIPE!);
    expect(pipe).toContain("| A | B |");
    expect(pipe).not.toContain(":::table");
  });
});

describe("applyTier (host auto-demote)", () => {
  it("demotes a lossless :::table of a simple grid down to a pipe table", () => {
    const lossless = ':::table\n<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>\n:::';
    const out = applyTier(tableTier, lossless);
    expect(out).not.toContain(":::table"); // demoted to the lowest level (open format)
    expect(out).toContain("| A | B |");
  });

  it("keeps :::table when the content needs it (merged or styled)", () => {
    expect(applyTier(tableTier, MERGED)).toContain(":::table");
    expect(applyTier(tableTier, MERGED)).toContain('colspan="2"');
    expect(applyTier(tableTier, STYLED)).toContain("background:#fee");
  });

  it("the level-cap seam clamps: capping at pipe best-efforts a merged grid down to pipe", () => {
    // pass-through default would keep :::table; an explicit pipe cap forces the lowest level.
    const out = applyTier(tableTier, MERGED, PIPE);
    expect(out).not.toContain(":::table");
    expect(out).toContain("|"); // a (lossy) pipe table
  });
});

// #93 / ADR-073: the layer-based tenant cap (the StandardLayer that flows from the entitlement —
// "gfm" / "directive") applied to the REAL table tier. This is exactly what the modal save calls.
describe("demoteToCapLevel (tenant macro level-cap, real table tier)", () => {
  it("cap=directive (default / UNLIMITED) is inert — keeps :::table when the grid needs it", () => {
    expect(demoteToCapLevel(tableTier, MERGED, "directive")).toContain(":::table");
    expect(demoteToCapLevel(tableTier, MERGED, "directive")).toContain('colspan="2"');
    // a simple grid still demotes to the lowest representable (pipe) — open formats
    expect(demoteToCapLevel(tableTier, SIMPLE_PIPE, "directive")).not.toContain(":::table");
  });

  it("cap=gfm forces a merged/styled table DOWN to a (lossy) pipe table — normalize, not reject", () => {
    const merged = demoteToCapLevel(tableTier, MERGED, "gfm");
    expect(merged).not.toContain(":::table"); // directive layer is above the cap → excluded
    expect(merged).toContain("|"); // a pipe table (the colspan is dropped — ADR-073 lossy normalize)
    const styled = demoteToCapLevel(tableTier, STYLED, "gfm");
    expect(styled).not.toContain(":::table");
    expect(styled).not.toContain("background:#fee"); // per-cell style can't survive in gfm
  });
});
