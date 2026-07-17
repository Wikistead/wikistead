import { describe, it, expect } from "vitest";
import { MCP_SYNTAX_MANIFEST, renderMcpSyntaxSections } from "@wikistead/macro-render";
import "./index"; // importing the assembly registers every first-party macro
import { registeredFenceLangs, registeredDirectiveNames } from "./index";

// #447 / ADR-172: registry↔manifest LOCK-STEP — the exportFidelity pattern applied to the MCP syntax
// reference. The server composes `get_syntax_reference` from MCP_SYNTAX_MANIFEST (macro-render), which
// the server can import; this test is what ties that manifest to the ACTUAL editor registry the server
// cannot import. The union of every entry's `names` must equal the registered fence+directive name set
// EXACTLY — no gaps (a macro shipped without documentation) and no orphans (documentation for a macro
// that no longer exists). Deliberately NO per-variant exclusion list: a sixth callout type fails here
// until its name joins an entry, which is the whole guarantee.
describe("MCP syntax manifest ↔ macro registry lock-step (#447 / ADR-172)", () => {
  const registered = [...registeredFenceLangs(), ...registeredDirectiveNames()].sort();
  const manifestNames = MCP_SYNTAX_MANIFEST.flatMap((e) => e.names);

  it("every registered macro name is documented by exactly one manifest entry", () => {
    expect([...manifestNames].sort()).toEqual(registered); // equality both ways: no gap, no orphan, no duplicate
  });

  it("every entry carries non-empty documentation and a section", () => {
    for (const e of MCP_SYNTAX_MANIFEST) {
      expect(e.names.length, "an entry must cover at least one name").toBeGreaterThan(0);
      expect(e.syntax.trim().length, `entry [${e.names.join(",")}] has syntax`).toBeGreaterThan(0);
      expect(e.section.trim().length, `entry [${e.names.join(",")}] has a section`).toBeGreaterThan(0);
    }
  });

  it("the rendered sections are deterministic and include every entry verbatim", () => {
    const rendered = renderMcpSyntaxSections();
    expect(renderMcpSyntaxSections()).toBe(rendered); // stable output — MCP clients may cache/diff
    for (const e of MCP_SYNTAX_MANIFEST) {
      expect(rendered, `syntax for [${e.names.join(",")}] is present`).toContain(e.syntax);
    }
  });
});
