// #813 / ADR-248 §3.2 + §3.3, carried forward by #978 / ADR-261: the two surfaces both surface the
// not-live state and both withhold publish.
//
// The reported accident happened on the guest surface, and the member surface has the same defect for
// a different reason: a member's socket dies the same way, it is only that a guest's credential also
// expires on a timer. So this reads the route table and asserts BOTH — a fix applied to one of two
// call sites is the shape this codebase keeps measuring (#737, #578, #815 each landed that way).
//
// #978 replaced the always-visible band (UnsavedBanner) with a dismissible toast, and that traded a
// silent withholding for a real one: dismissing the toast and then clicking Publish must still say
// something, or the reader gets total silence instead of a wrong "published". This file now also pins
// that pairing.
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

// The full gate block, not just the guard condition — see the "pairs the withholding with its own
// toast" test below for why the whole block, not the `if (...) return;` fragment, is what has to hold.
const GATE = /if \(!livenessRef\.current\.live\) \{\s*notify\.error\(t\("toast\.publishBlockedNotLive"\)\);\s*return;\s*\}/g;

describe("#813 both editing surfaces know whether their edits are arriving", () => {
  const tags = editorTags();

  it("there are two of them, and the count is checked so this cannot go quiet", () => {
    // A third surface added later must fail here rather than inherit the silence.
    expect(tags.length, "the Editor call sites moved — re-read this file before trusting it").toBe(2);
  });

  it("each one reports its liveness to its host", () => {
    for (const tag of tags) {
      expect(tag, "an Editor whose host cannot see the connection cannot surface the state").toContain("onLiveness={onLiveness}");
    }
  });

  it("each one is preceded by its own not-live toast wiring", () => {
    // The toast itself is driven by an effect, not JSX, and the hook is declared near the top of
    // each component (with the other liveness hooks) rather than immediately above the Editor tag —
    // unlike the retired band, so this checks ORDER within the file rather than proximity: surface i's
    // wiring call must come before surface i's tag, and (by construction, since the two components
    // appear in file order) before surface i's tag rather than a later one.
    const wiredIdx = [...SRC.matchAll(/useNotLiveToast\(/g)].map((m) => m.index!);
    expect(wiredIdx.length, "one not-live toast per editing surface").toBe(2);
    const tagIdx = tags.map((tag) => SRC.indexOf(tag));
    tagIdx.forEach((idx, i) => {
      expect(wiredIdx[i], "the toast wiring must be declared above its surface").toBeLessThan(idx);
    });
  });

  it("⚠️ both publish paths read the answer from a ref, at the moment of the click", () => {
    // Not from a closed-over value. Both publish callbacks are `useCallback`-stable on purpose — the
    // editor's vim `:w` wiring captures them when the surface mounts (#448) — so a gate reading a
    // state variable would answer with whatever was true at mount. The choice would be between no
    // gate and a stale one.
    const gates = SRC.match(GATE) ?? [];
    expect(gates.length, "one gate per publish path (member and guest)").toBe(2);
    expect(SRC).toContain("livenessRef.current = liveness");
  });

  it("#978 pairs the withholding with its own toast — the return is no longer silent", () => {
    // A gate that still matched the bare `if (...) return;` shape (no toast in the block) would pass
    // the test above too, since that regex only anchors on the condition. Assert the FULL block
    // literally, so a regression that drops the notify call while keeping the guard is caught here.
    const gates = SRC.match(GATE) ?? [];
    expect(gates.length, "the toast must be inside the SAME block as the guard, not bolted on elsewhere").toBe(2);
  });

  it("and the gate sits before the request, not after it", () => {
    for (const m of SRC.matchAll(GATE)) {
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
