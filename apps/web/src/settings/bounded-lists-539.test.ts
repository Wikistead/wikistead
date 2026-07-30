// #539: a settings list that grows with the data must scroll INSIDE a bounded box, so whatever sits
// below it stays reachable.
//
// This is the THIRD time the same failure shipped — the audit ledger (#503), the patrol queue (#521), and
// now the space member list, each pushing the settings beneath it past the fold. Fixing the third one and
// writing a third bespoke test would leave the fourth to be found by a user too. So the pin is written
// over ALL the known instances at once: adding a growing list to this family means adding a row here, and
// removing the bound from any of them turns it red.
//
// Lexical, like the #510 destructive-guard: "this list is bounded and scrolls" is a property of the
// markup, and happy-dom has no layout engine to measure with. Whether it LOOKS right stays a review.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// file → the testid of the list element that must be bounded.
const BOUNDED_LISTS: { file: string; testid: string; ticket: string }[] = [
  { file: "AdminAuditTab.tsx", testid: "audit-scrollbox", ticket: "#503 audit ledger" },
  { file: "SpaceModerationTab.tsx", testid: "moderation-list", ticket: "#521 patrol queue" },
  // #536 ①: the grant list and the assignment list merged into ONE member list — one bounded box.
  { file: "SpaceMembersTab.tsx", testid: "space-member-list", ticket: "#539/#536 space members" },
  // (review reject): the FOURTH instance was missed in the very fix that promised "add a row
  // here" — the mapping list sat unbounded right below the two lists that were fixed.
  { file: "SpaceGroupMappings.tsx", testid: "space-mapping-list", ticket: "#539 group mappings" },
];

// The element's own class list — read back from the tag that carries the testid.
function classesOf(file: string, testid: string): string {
  const src = readFileSync(resolve(import.meta.dirname, `./${file}`), "utf8");
  const at = src.indexOf(`data-testid="${testid}"`);
  expect(at, `${file}: the ${testid} list still exists (renamed? re-aim this row)`).toBeGreaterThan(-1);
  const open = src.lastIndexOf("<", at);
  const tag = src.slice(open, src.indexOf(">", at) + 1);
  const m = /className=\{?"([^"]*)"/.exec(tag);
  return m?.[1] ?? "";
}

describe("#539: growing settings lists scroll inside a bounded box", () => {
  it.each(BOUNDED_LISTS)("$ticket is height-capped and scrolls internally", ({ file, testid }) => {
    const cls = classesOf(file, testid);
    // A cap without overflow clips the rest; overflow without a cap never scrolls. Both, or neither works.
    expect(cls, "has a height cap").toMatch(/max-h-\[/);
    expect(cls, "and scrolls inside it").toContain("overflow-y-auto");
  });

  it("they all use the SAME cap, so the three surfaces do not drift apart", () => {
    const caps = BOUNDED_LISTS.map(({ file, testid }) => /max-h-\[([^\]]+)\]/.exec(classesOf(file, testid))?.[1]);
    expect(caps.filter(Boolean).length, "every list reported a cap").toBe(BOUNDED_LISTS.length);
    expect(new Set(caps).size, `one shared height, got ${JSON.stringify(caps)}`).toBe(1);
  });
});
