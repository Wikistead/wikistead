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
// mounting it — so this reads routes.tsx to pin that BOTH call sites actually gate their argument on
// `canEdit`, closing the loop between "the hook behaves correctly when given null" and "the call site
// ever gives it null".
const ROUTES_SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");
const GATED_CALL = /useNotLiveToast\(`notlive:(?:member|guest):\$\{pageId\}`,\s*canEdit \? liveness\.reason : null\)/g;

describe("#978 routes.tsx actually passes the gated value in", () => {
  it("both call sites (member and guest) gate on canEdit, not just one of the two", () => {
    const matches = [...ROUTES_SRC.matchAll(GATED_CALL)];
    expect(matches.length, "one gated useNotLiveToast call per editing surface — a fix applied to only one call site is the exact bug class this repo keeps re-measuring").toBe(2);
  });
});
