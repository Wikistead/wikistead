// ADR-177 §2 (#450): there is ONE macro dispatch, and every surface goes through it.
//
// Before this, three call sites reached `liveRender` independently — the CM widget, the fence sink and
// the directive sink — and each re-implemented what happens around it. That is where "`:::children`
// renders top-level but not nested" came from: a fix applied at one site simply did not exist at the
// others. Keeping them in step by review is what failed; this keeps them in step by construction.
//
// It is also a pre-condition of the macro SDK (ADR-177 §3, Review-gated): when a macro is handed more
// than `{theme}`, exactly one function must decide what it gets. A second dispatch site would be a
// second, ungoverned answer to that question.
//
// The check is deliberately lexical (the destructive-guard precedent): the property is "no OTHER call
// site exists", which is about the source text, not about runtime behaviour. Note `decorations.ts` is
// >400KB and reads as BINARY to some tools — a plain grep silently reports zero matches on it, which is
// how a previous investigation concluded a seam was unwired. Reading the file directly avoids that.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const SRC = resolve(import.meta.dirname, "../..");
const DISPATCH_FILE = "editor/macros/md-render.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("#450 / ADR-177 §2 — one macro dispatch", () => {
  it("liveRender is called from exactly ONE place in the whole source", () => {
    // Counted across every file, INCLUDING the helper's own — an earlier cut of this test exempted that
    // file wholesale and so could not see a direct call added right next to the helper, which is precisely
    // where the two sinks that historically drifted live. One call, one place, no exemptions.
    const hitsByFile: string[] = [];
    let total = 0;
    for (const f of sourceFiles(SRC)) {
      const src = readFileSync(f, "utf8");
      const n = src.match(/\.liveRender\(/g)?.length ?? 0;
      if (!n) continue;
      total += n;
      hitsByFile.push(`${relative(SRC, f).replace(/\\/g, "/")} (${n})`);
    }
    expect(total, "the dispatch still exists (a broken walk must not pass vacuously)").toBeGreaterThan(0);
    expect(
      hitsByFile,
      "every surface must go through dispatchMacroRender (ADR-177 §2) — one call site, in md-render.ts",
    ).toEqual([`${DISPATCH_FILE} (1)`]);
  });

  it("the helper is exported for the surfaces that need it", () => {
    const src = readFileSync(join(SRC, DISPATCH_FILE), "utf8");
    expect(src).toMatch(/export function dispatchMacroRender\(/);
    // The widget surface keeps its own throw semantics; the flag exists so that difference is visible
    // rather than implicit, and a later slice can remove it deliberately.
    expect(src).toMatch(/onThrow/);
  });
});
