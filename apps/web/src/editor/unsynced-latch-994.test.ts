// @vitest-environment happy-dom
//
// #994 / ADR-276: a connection band is not a content band.
//
// THE DEFECT: `useNotLiveToast` rendered "your changes are not being saved" (collab.notSaving.title)
// from `notLiveReason`, which is a pure function of the CONNECTION — socket up,
// authenticated, scope, initial sync done. It never asked whether anything had been typed. So every
// ordinary page load claimed unsaved changes for the window between mount and first sync, when
// there were no changes at all.
//
// This measures the rule that replaces it. It is deliberately driven WITHOUT a socket or a real
// provider: the three quirks the design has to survive (a counter that resets to 1 on every socket
// open, a counter with no floor at zero, and an ack per keystroke while live) are all reachable here
// as plain method calls, and two of them are not reproducible against a healthy local server at all.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUnsyncedLatch } from "./unsyncedSignal";
import { toastReason } from "./useNotLiveToast";

/** Drive a latch and record every value it actually notifies. */
function latchWithLog() {
  const seen: boolean[] = [];
  const latch = createUnsyncedLatch((v) => seen.push(v));
  return { latch, seen };
}

describe("#994 the unsynced latch", () => {
  it("⚠️ a page open with zero edits is NOT unsynced, even while the connection is not live", () => {
    // THE defect this ADR exists to close. `startSync()` calls `resetUnsyncedChanges()` on EVERY
    // socket open and that assigns 1, not 0 — so the provider's own counter says "pending" here.
    // A design that mirrored the counter would have relocated the false positive, not fixed it.
    const { latch, seen } = latchWithLog();
    latch.noteLive(false); // mount: not connected yet
    latch.noteAck(1); // the provider's reset-to-1 on socket open, with nothing typed
    expect(latch.value, "a reader who has typed nothing has nothing at risk").toBe(false);
    expect(seen, "and nobody is notified, so the toast never renders").toEqual([]);
  });

  it("a local edit while not live IS unsynced", () => {
    const { latch, seen } = latchWithLog();
    latch.noteLive(false);
    latch.noteLocalUpdate();
    expect(latch.value).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("⚠️ live typing never notifies the host — no matter how often the latch itself flips", () => {
    // The invariant [[editor-dirty-presence-constraint]] measured (presence e2e 3/3): editor-derived
    // state on the host's React render path breaks awareness. The server acks roughly one message per
    // Y.Doc update, so the raw count toggles 0↔1 at keystroke speed; the AND with liveness is what
    // makes "the host is not notified" a property of the value rather than a hope about the counter.
    const { latch, seen } = latchWithLog();
    latch.noteLive(true);
    for (let i = 0; i < 200; i++) {
      latch.noteLocalUpdate(); // the keystroke
      latch.noteAck(1); // the provider's increment
      latch.noteAck(0); // the server's ack
    }
    expect(latch.value).toBe(false);
    expect(seen.length, "200 keystrokes produced host re-renders").toBe(0);
  });

  it("the provider's ack clears a latch set while offline", () => {
    const { latch, seen } = latchWithLog();
    latch.noteLive(false);
    latch.noteLocalUpdate();
    latch.noteAck(1); // reconnect: startSync resets to 1 — still pending, must NOT clear
    expect(latch.value, "the handshake is not the ack").toBe(true);
    latch.noteAck(0); // the server took it
    expect(latch.value).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("⚠️ a count that has overshot past zero still clears (the counter has no floor)", () => {
    // `decrementUnsyncedChanges()` has no floor, and a reconnect that flushes queued sends against a
    // counter just reset to 1 drives it negative. A strict `=== 0` clear would leave the latch stuck
    // true forever after that; a strict `n > 0` MIRROR would have gone the other way and reported
    // "nothing pending" forever. `<= 0` is what absorbs it.
    const { latch } = latchWithLog();
    latch.noteLive(false);
    latch.noteLocalUpdate();
    latch.noteAck(-3);
    expect(latch.value, "an overshot count still means the server has everything").toBe(false);
  });

  it("going live clears the VALUE without clearing the latch's own memory of the edit", () => {
    // Liveness alone is not an ack. The value goes false because the toast is about edits AT RISK,
    // and a live connection is not a risk — but if the connection drops again before any ack, the
    // still-unsent edit must come back.
    const { latch } = latchWithLog();
    latch.noteLive(false);
    latch.noteLocalUpdate();
    latch.noteLive(true);
    expect(latch.value).toBe(false);
    latch.noteLive(false);
    expect(latch.value, "an edit the server never acknowledged is still at risk").toBe(true);
  });

  it("starts at 'nothing pending' — a surface that never connects must not claim otherwise", () => {
    // ADR-276 open question 3: a view-only member never calls `connect()` at all, so nothing ever
    // writes this. The default is the answer they get.
    const { latch, seen } = latchWithLog();
    expect(latch.value).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("#994 toastReason decides what the band may say", () => {
  it("⚠️ not-live with nothing typed is silent — the whole point", () => {
    expect(toastReason({ canEdit: true, reason: "connecting", unsynced: false })).toBeNull();
    expect(toastReason({ canEdit: true, reason: "syncing", unsynced: false })).toBeNull();
    expect(toastReason({ canEdit: true, reason: "unauthenticated", unsynced: false })).toBeNull();
  });

  it("not-live WITH an unsent edit speaks, and says which reason", () => {
    expect(toastReason({ canEdit: true, reason: "connecting", unsynced: true })).toBe("connecting");
    expect(toastReason({ canEdit: true, reason: "syncing", unsynced: true })).toBe("syncing");
  });

  it("⚠️ read-only speaks with nothing typed (owner ruling ②)", () => {
    // Losing edit rights is not the kind of fact you wait for a keystroke to report. This is the one
    // case whose correct behaviour is counter-intuitive enough to regress silently, which is why the
    // ADR names it as a required pin.
    expect(toastReason({ canEdit: true, reason: "read-only", unsynced: false })).toBe("read-only");
  });

  it("a live connection says nothing whatever the latch holds", () => {
    expect(toastReason({ canEdit: true, reason: null, unsynced: true })).toBeNull();
  });

  it("#978 a view-only surface stays silent, including when read-only", () => {
    // View-only never joins the collab room, so its liveness is permanently stuck at the initial
    // "connecting" with no event that could ever clear it. The read-only bypass must not resurrect
    // that — a reader who never had edit rights has not lost any.
    expect(toastReason({ canEdit: false, reason: "connecting", unsynced: true })).toBeNull();
    expect(toastReason({ canEdit: false, reason: "read-only", unsynced: false })).toBeNull();
  });
});

describe("#994 the two editing surfaces both route through toastReason", () => {
  // `notlive-toast-view-only-978.test.ts` pinned the previous expression at both call sites for the
  // same reason: a fix applied to one surface and not the other is the bug class this repo keeps
  // re-measuring (#978 was exactly that). The gate now lives in one function, so what has to
  // be pinned is that both call sites reach it.
  const ROUTES_SRC = readFileSync(resolve(import.meta.dirname, "../app/routes.tsx"), "utf8");

  it("both call sites (member and guest) pass toastReason's answer, not the raw reason", () => {
    const gated = [
      ...ROUTES_SRC.matchAll(
        /useNotLiveToast\(`notlive:(?:member|guest):\$\{pageId\}`,\s*toastReason\(\{ canEdit, reason: liveness\.reason, unsynced \}\), liveness\.live\)/g,
      ),
    ];
    // `liveness.live` is part of the shape on purpose: #980's grace latches "has been live" on it,
    // and a call site that dropped it would silently re-arm the grace on every page. See
    // `notlive-compose-980-994.test.ts`.
    expect(gated.length, "one gated call per editing surface").toBe(2);
    expect([...ROUTES_SRC.matchAll(/useNotLiveToast\(/g)].length, "and no third, ungated call site").toBe(2);
  });

  it("the member surface clears the store on a page switch, in dirtySig's own effect", () => {
    // Owner ruling ③. This route holds ONE store across every page it shows, so without the reset a
    // previous page's unsent edit would ring the next page's toast — including on a page the member
    // can only view, where nothing ever reports and nothing would ever clear it.
    expect(ROUTES_SRC).toMatch(/dirtySig\.set\(false\); unsyncedSig\.set\(false\);/);
  });

  // ⚠️ The two hops BETWEEN the seam and the reader. Review of this ticket deleted each of these
  // lines in turn and the whole web suite stayed green (270 files / 2147 tests, both times): the
  // prop is optional, so the types pass, and the failure is total silence — `unsynced` is false
  // forever and a real unsent edit is never reported, which is the #813 accident itself. The rule,
  // the seam and the reader were all pinned; the thread between them was not.
  const EDITOR_SRC = readFileSync(resolve(import.meta.dirname, "Editor.tsx"), "utf8");

  it("⚠️ both Editor tags hand the host's onUnsyncedChanges down (routes.tsx)", () => {
    // Same shape as publish-withheld-813's `editorTags()`: a real tag has props, prose mentions of
    // `<Editor>` do not, so the pattern requires `docName=`.
    const tags = [...ROUTES_SRC.matchAll(/<Editor\s+[^>]*docName=[^>]*>/g)].map((m) => m[0]);
    expect(tags.length, "the Editor call sites moved — re-read this file before trusting it").toBe(2);
    for (const tag of tags) {
      expect(tag, "an Editor that is not handed the callback can never report an unsent edit")
        .toContain("onUnsyncedChanges={onUnsyncedChanges}");
    }
  });

  it("⚠️ the Editor passes it through to connect() (Editor.tsx)", () => {
    // Through the ref, not the prop: the collab effect's dependency list must not grow (a host
    // re-render would otherwise tear the Y.Doc down), which is the same treatment `onLiveness` gets.
    const connectCall = EDITOR_SRC.match(/connect\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(connectCall, "connect() is called with an options object").not.toBe("");
    expect(connectCall).toMatch(/onUnsyncedChanges:\s*\(unsynced\)\s*=>\s*onUnsyncedChangesRef\.current\?\.\(unsynced\)/);
  });
});
