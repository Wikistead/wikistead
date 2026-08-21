// #813 / ADR-248 §3.2 + §3.3: the two surfaces both wear the band and both withhold publish.
//
// The reported accident happened on the guest surface, and the member surface has the same defect for
// a different reason: a member's socket dies the same way, it is only that a guest's credential also
// expires on a timer. So this reads the route table and asserts BOTH — a fix applied to one of two
// call sites is the shape this codebase keeps measuring (#737, #578, #815 each landed that way).
//
// It reads the source rather than rendering because the two call sites are inside a 1,400-line route
// module with a live query client, a collab socket and a CodeMirror surface behind them. What it
// checks is wiring, and wiring is legible: which props are passed, and what the publish path reads
// before it acts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");

/**
 * Every real `<Editor …>` tag in the table, as one string each.
 *
 * ⚠️ It requires a prop. The prose in this file says `<Editor>` seven times while explaining why the
 * memo holds, and a pattern that only asked for the tag name counted those too — nine "call sites",
 * seven of them sentences. Both sides were counted: 2 tags with props, 7 bare mentions.
 */
function editorTags(): string[] {
  return [...SRC.matchAll(/<Editor\s+[^>]*docName=[^>]*>/g)].map((m) => m[0]);
}

describe("#813 both editing surfaces know whether their edits are arriving", () => {
  const tags = editorTags();

  it("there are two of them, and the count is checked so this cannot go quiet", () => {
    // A third surface added later must fail here rather than inherit the silence.
    expect(tags.length, "the Editor call sites moved — re-read this file before trusting it").toBe(2);
  });

  it("each one reports its liveness to its host", () => {
    for (const tag of tags) {
      expect(tag, "an Editor whose host cannot see the connection cannot show the band").toContain("onLiveness={onLiveness}");
    }
  });

  it("each one is preceded by the band", () => {
    // Above the surface, in the page chrome — never inside CodeMirror's DOM, where an appearing and
    // disappearing block enters the height map and shifts every line below it.
    const banners = SRC.match(/<UnsavedBanner\b/g) ?? [];
    expect(banners.length, "one band per editing surface").toBe(2);
    for (const tag of tags) {
      const before = SRC.slice(Math.max(0, SRC.indexOf(tag) - 400), SRC.indexOf(tag));
      expect(before, "the band must render above its surface").toContain("<UnsavedBanner");
    }
  });

  it("⚠️ both publish paths read the answer from a ref, at the moment of the click", () => {
    // Not from a closed-over value. Both publish callbacks are `useCallback`-stable on purpose — the
    // editor's vim `:w` wiring captures them when the surface mounts (#448) — so a gate reading a
    // state variable would answer with whatever was true at mount. The choice would be between no
    // gate and a stale one.
    const gates = SRC.match(/if \(!livenessRef\.current\.live\) return;/g) ?? [];
    expect(gates.length, "one gate per publish path (member and guest)").toBe(2);
    expect(SRC).toContain("livenessRef.current = liveness");
  });

  it("and the gate sits before the request, not after it", () => {
    for (const m of SRC.matchAll(/if \(!livenessRef\.current\.live\) return;/g)) {
      const after = SRC.slice(m.index!, m.index! + 600);
      const rest = SRC.slice(Math.max(0, m.index! - 600), m.index!);
      // Whatever each path does to publish, it must not have started before the gate. Asserting the
      // absence of the call ABOVE the gate is what makes this about ordering rather than presence.
      expect(rest, "a publish that has already been sent cannot be withheld")
        .not.toMatch(/publishMutate\(|\/publish`/);
      expect(after).toMatch(/publishMutate\(|\/publish`/);
    }
  });
});
