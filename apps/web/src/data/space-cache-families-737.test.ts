import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "queries.ts"), "utf8");

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
    // The literal shape the bug had. Finding it again means a mutation went around the helper.
    const byHand = [...source.matchAll(/invalidateQueries\(\{\s*queryKey:\s*\[\s*"(spaces[^"]*)"\s*\]/g)].map((m) => m[1]);
    expect(byHand, `use invalidateSpaces(qc) instead: ${byHand.join(", ")}`).toEqual([]);
  });

  it("invalidateSpaces actually asks for every family (the helper is measured, not trusted)", () => {
    const asked: unknown[] = [];
    invalidateSpaces({ invalidateQueries: (arg: { queryKey: unknown[] }) => asked.push(arg.queryKey[0]) } as never);
    expect(asked.sort()).toEqual([...SPACE_QUERY_FAMILIES].sort());
  });
});
