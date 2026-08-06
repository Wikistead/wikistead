// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DECLARED, declaredCapabilities } from "./macro-sdk";
import { ALLOWED_CAPABILITIES } from "./macro-registry";

// #555 / ADR-177: a macro that declares NOTHING is handed the first-party defaults — including
// `host-embed`, which a declaring macro is not allowed to ask for.
//
// That asymmetry is deliberate and safe TODAY for one reason only: every macro reaching `registerMacro`
// is first-party, written in this tree, in one file. The moment #182 wires a marketplace install path,
// a manifest with no `capabilities` field registers a macro that gets `host-embed` by default — and the
// trust-boundary ruling this ticket exists to obtain would have been pre-empted by a default nobody
// chose.
//
// That risk was found by an independent review (#555/) and written down as a recommendation
// to whoever implements #182. A recommendation in a comment is how the same thing has gone wrong twice
// on this board in one day — an item ruled mandatory reached one document and not the other, and nobody
// noticed because the surviving document looked complete. So it is a pin instead.
//
// WHAT THIS PIN IS NOT: it does not change the contract. `declaredCapabilities` still hands the defaults
// to an undeclared macro, because narrowing that is a change to the macro contract and belongs to the
// ruling, not to a test. What it refuses is a SECOND registration path arriving without anybody
// revisiting the question.
describe("#555: the registration surface is first-party, and stays visible", () => {
  const MACROS = resolve(import.meta.dirname);

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) out.push(...files(p));
      else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
    }
    return out;
  }

  /** Files that CALL `registerMacro`, comments stripped — prose naming it is not a call site. */
  function callers(): string[] {
    return files(MACROS)
      .filter((f) => {
        const src = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
        // The DEFINITION is not a call site. Measured: the first version counted `registry.ts` — the
        // file that declares `export function registerMacro` — and reported the product as having two
        // registration paths when it has one. A check that cries wolf on the state it exists to protect
        // is a check somebody deletes.
        const withoutDefinition = src.replace(/export\s+function\s+registerMacro\b/g, " ");
        return /\bregisterMacro\b\s*\(|\.forEach\(\s*registerMacro\s*\)/.test(withoutDefinition);
      })
      .map((f) => f.slice(f.indexOf("/src/") + 1));
  }

  it("finds the registration it knows about (a broken pattern must not pass vacuously)", () => {
    expect(callers(), "the first-party registry registers macros").toContain("src/editor/macros/index.ts");
  });

  it("there is exactly ONE place macros are registered", () => {
    // When this goes red, it is almost certainly #182 adding the marketplace install path — and the
    // question to answer before making it green is the one in the block comment above: does that path
    // require `capabilities` explicitly, or does it let an undeclared manifest inherit `host-embed`?
    //
    // Making this green by adding the new file to a list would be answering "no" without noticing.
    expect(
      callers(),
      "a second registration path appeared. An undeclared macro inherits DEFAULT_DECLARED, which " +
      "includes `host-embed` — a capability a DECLARING macro cannot ask for (#555 is the ruling on " +
      "whether third parties may). Require explicit capabilities on that path before this is green.",
    ).toEqual(["src/editor/macros/index.ts"]);
  });

  it("…and the asymmetry that makes it matter is still real", () => {
    // If `host-embed` ever leaves DEFAULT_DECLARED, or joins ALLOWED_CAPABILITIES, the case above stops
    // guarding anything and should be reconsidered rather than left running. Stated so the pin cannot
    // outlive its reason.
    expect(DEFAULT_DECLARED, "an undeclared macro still gets host-embed").toContain("host-embed");
    expect(ALLOWED_CAPABILITIES.has("host-embed"), "and a declaring one still cannot ask for it").toBe(false);
  });

  it("the default really is handed out when nothing is declared", () => {
    // The mechanism itself, measured rather than read: this is what a marketplace manifest with no
    // `capabilities` field would receive.
    expect(declaredCapabilities({}).has("host-embed")).toBe(true);
    expect(declaredCapabilities({ capabilities: ["theme"] }).has("host-embed"), "declaring narrows it").toBe(false);
  });
});
