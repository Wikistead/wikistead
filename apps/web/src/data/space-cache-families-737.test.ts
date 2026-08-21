import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SPACE_QUERY_FAMILIES, invalidateSpaces } from "./queries";

// #737: an uploaded space icon saved and never appeared. The server was right on both routes
// (measured with curl: `/spaces` and `/spaces/resolve` both return the URL after the upload) — the
// screens showing it read `["spaces-resolve", ids]`, and every mutation invalidated `["spaces"]`,
// which React Query matches element by element and therefore never reaches.
//
// The pin WALKS THE FILE rather than listing the families it expects. A hand-written list would have
// passed on the day `spaces-resolve` was added, which is exactly the day this broke: #710 introduced
// a fourth reader and nothing asked whether the invalidations had followed.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "queries.ts"), "utf8");

/** Every shipped file under apps/web/src — the whole app; tests are not shipped. */
function shippedWebFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(join(here, ".."));
  return out;
}

/** Every `queryKey: ["…"]` literal in the data layer whose family name is space-shaped. */
function spaceQueryFamiliesInSource(): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/queryKey:\s*\[\s*"([^"]+)"/g)) {
    if (/^spaces(-|$)/.test(m[1])) found.add(m[1]);
  }
  return [...found].sort();
}

describe("#737: every cache that holds a Space is invalidated together", () => {
  it("the walk finds families at all (an empty walk is a broken pin, not full coverage)", () => {
    expect(spaceQueryFamiliesInSource().length).toBeGreaterThanOrEqual(4);
  });

  it("SPACE_QUERY_FAMILIES covers every space-shaped query key the file defines", () => {
    const inSource = spaceQueryFamiliesInSource();
    const missing = inSource.filter((f) => !(SPACE_QUERY_FAMILIES as readonly string[]).includes(f));
    expect(missing, `these query families would go stale after a mutation: ${missing.join(", ")}`).toEqual([]);
  });

  it("and lists nothing that no longer exists (a stale entry is a claim about a cache nobody reads)", () => {
    const inSource = spaceQueryFamiliesInSource();
    const orphaned = (SPACE_QUERY_FAMILIES as readonly string[]).filter((f) => !inSource.includes(f));
    expect(orphaned, `these families are declared but no query uses them: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("no mutation invalidates a single space family by hand — that is how this defect was written", () => {
    // #845: this used to read `source` — queries.ts alone — while the second occurrence of the very
    // same bug was written in routes.tsx, where it sat for weeks with the check green beside it. A
    // caller that goes around the helper is a caller ANYWHERE, so the walk covers the whole app. The
    // file count is asserted because a walk that stops finding files looks exactly like a codebase
    // with nothing to report.
    const files = shippedWebFiles();
    expect(files.length, "the walk found no source files — it is measuring nothing").toBeGreaterThan(100);
    const byHand: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/invalidateQueries\(\{\s*queryKey:\s*\[\s*"(spaces[^"]*)"\s*\]/g)) {
        byHand.push(`${file.slice(file.lastIndexOf("apps/web"))}: ["${m[1]}"]`);
      }
    }
    expect(byHand, `${files.length} file(s) walked; use invalidateSpaces(qc) instead of naming one family:\n${byHand.join("\n")}`).toEqual([]);
  });

  it("invalidateSpaces actually asks for every family (the helper is measured, not trusted)", () => {
    const asked: unknown[] = [];
    invalidateSpaces({ invalidateQueries: (arg: { queryKey: unknown[] }) => asked.push(arg.queryKey[0]) } as never);
    expect(asked.sort()).toEqual([...SPACE_QUERY_FAMILIES].sort());
  });
});
