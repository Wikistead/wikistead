// @vitest-environment happy-dom
//
// #978 (review rejection): a view-only reader gets a persistent "changes aren't saved"
// toast that never clears.
//
// THE DEFECT: Editor.tsx's collab connection is edit-capable-only (view-only never joins the collab
// room — nothing to report liveness about), so a view-only surface's `liveness` state never leaves its
// initial `{live: false, reason: "connecting"}`. Both `useNotLiveToast` call sites in routes.tsx
// (member ~:612, guest ~:1429) were unconditional, so every view-only member and every view-only
// share-link visitor saw a `duration: Infinity` false-positive toast on every page, with nothing ever
// making it go away except a manual dismiss.
//
// This renders the REAL hook (not a source-string pin) through react-dom so its `useEffect` actually
// runs, and asserts both directions: an edit-capable caller stuck at "connecting" must still get the
// toast (otherwise the fix could be "always suppress"), while a view-only caller in the exact same
// stuck state must not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }) }));

const persistent = vi.fn();
const dismiss = vi.fn();
vi.mock("../ui/toast", () => ({ notify: { persistent: (...a: unknown[]) => persistent(...a), dismiss: (...a: unknown[]) => dismiss(...a) } }));

const { useNotLiveToast, GRACE_MS } = await import("../editor/useNotLiveToast");

async function mount(id: string, reason: "connecting" | null) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const Probe = () => { useNotLiveToast(id, reason); return null; };
  await act(async () => { root.render(createElement(Probe)); });
  return { unmount: () => act(async () => { root.unmount(); }) };
}

describe("#978 the not-live toast is gated on edit capability", () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    persistent.mockClear();
    dismiss.mockClear();
  });

  it("an edit-capable caller stuck at reason=connecting still gets the toast", async () => {
    // The gate this test guards is `canEdit ? liveness.reason : null` in routes.tsx — simulated here
    // by the caller passing the reason straight through, as the edit-capable branch does. This is a
    // pre-live surface (never yet reached `reason: null`), so #980's grace period applies — the toast
    // shows only once GRACE_MS has elapsed with no recovery, which "stuck" means it will.
    vi.useFakeTimers();
    try {
      const { unmount } = await mount("notlive:member:p1", "connecting");
      await act(async () => { vi.advanceTimersByTime(GRACE_MS); });
      expect(persistent, "an edit-capable surface genuinely stuck connecting must still warn").toHaveBeenCalledTimes(1);
      expect(persistent.mock.calls[0][0]).toBe("notlive:member:p1");
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("⚠️ a view-only caller, same stuck state, must NOT get the toast", async () => {
    // View-only never joins the collab room, so its `liveness.reason` is permanently "connecting" with
    // no event that will ever clear it — the routes.tsx call site passes `null` in this branch instead
    // of the raw reason. That `null` is what this test stands in for.
    const { unmount } = await mount("notlive:member:p1", null);
    expect(persistent, "a view-only surface has nothing to report — this must stay silent forever, not eventually").not.toHaveBeenCalled();
    await unmount();
  });
});

// The two tests above pin the HOOK's own contract (reason=null is silent, a real reason warns), which
// is true in isolation regardless of what routes.tsx actually passes it. Neither call site can be
// rendered directly here — each sits inside a 1,400-line route component behind a live query client and
// a collab socket, the same reason `publish-withheld-813.test.ts` reads this file as source rather than
// mounting it — so what remains is to pin that the value the call sites hand in is `null` for a
// view-only reader, closing the loop between "the hook behaves correctly when given null" and "the
// call site ever gives it null".
//
// #994 / ADR-276 moved that expression out of both call sites and into `toastReason`, so the gate is
// now a function this can drive DIRECTLY rather than a shape it has to recognise in source — a
// strictly better pin than the regex that used to stand here. The remaining source question ("do both
// call sites actually reach `toastReason`") is pinned in `editor/unsynced-latch-994.test.ts` alongside
// the rest of that ticket's call-site wiring, so it is not duplicated here.
const { toastReason } = await import("../editor/useNotLiveToast");

describe("#978 the gate the call sites use answers null for a view-only reader", () => {
  it("view-only is silent even in the permanently-stuck state that produced the report", () => {
    // View-only never joins the collab room, so `liveness` is stuck at its initial
    // {live:false, reason:"connecting"} with no event that could ever clear a `duration: Infinity`
    // toast. Both the unsent-edit and no-unsent-edit cases must stay silent — the #994 gate that now
    // sits alongside this one must not have made view-only reachable again through its other branch.
    expect(toastReason({ canEdit: false, reason: "connecting", unsynced: false })).toBeNull();
    expect(toastReason({ canEdit: false, reason: "connecting", unsynced: true })).toBeNull();
    expect(toastReason({ canEdit: false, reason: "read-only", unsynced: true })).toBeNull();
  });

  it("and an edit-capable reader with a real unsent edit is NOT silenced by that gate", () => {
    // Otherwise the fix could be "always suppress", which is the failure mode in the other direction.
    expect(toastReason({ canEdit: true, reason: "connecting", unsynced: true })).toBe("connecting");
  });
});
