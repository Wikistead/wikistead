// @vitest-environment happy-dom
//
// #994 / ADR-276 owner ruling ②: `read-only` gets its own title.
//
// Every other reason is a waiting state and the shared title ("your changes are not being saved") is
// about content at risk. Read-only is announced BEFORE any edit exists — it bypasses the unsent-edit
// gate deliberately, because losing edit rights is not the kind of fact you wait for a keystroke to
// report. Under the shared title that announcement would be claiming unsaved changes that may not
// exist. It is also an implementation necessity: a read-only server answers `writeSyncStatus(false)`
// and therefore never decrements, so once the reader HAS typed, the shared title would sit there
// saying "not saved" for the rest of the session.
//
// This renders the REAL hook through react-dom so the effect actually runs — a source-string pin
// would go green on a mapping that some earlier branch had already made unreachable.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const persistent = vi.fn();
const dismiss = vi.fn();
vi.mock("../ui/toast", () => ({
  notify: { persistent: (...a: unknown[]) => persistent(...a), dismiss: (...a: unknown[]) => dismiss(...a) },
}));

const { useNotLiveToast, GRACE_MS } = await import("./useNotLiveToast");
import type { NotLiveReason } from "./liveness";

// The surfaces here have never been live, so #980's pre-live grace applies to every reason EXCEPT
// read-only (which skips it — see the second test). Advancing past GRACE_MS makes both paths
// observable in the same harness instead of only the one that happens not to wait.
async function mount(reason: NotLiveReason) {
  const root = createRoot(document.createElement("div"));
  const Probe = () => { useNotLiveToast("notlive:x", reason); return null; };
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { vi.advanceTimersByTime(GRACE_MS); });
  return { unmount: () => act(async () => { root.unmount(); }) };
}

describe("#994 the not-live toast's title", () => {
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    persistent.mockClear();
    dismiss.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("⚠️ read-only does NOT say 'your changes are not being saved'", async () => {
    const { unmount } = await mount("read-only");
    expect(persistent).toHaveBeenCalledTimes(1);
    const [, title, body] = persistent.mock.calls[0] as [string, string, string];
    expect(title, "the read-only case must speak about edit rights, not about unsaved content")
      .toBe("collab.notSaving.readOnlyTitle");
    expect(body).toBe("collab.notSaving.readOnly");
    await unmount();
  });

  it("every OTHER reason keeps the shared title — the split is one case, not a rewrite", async () => {
    for (const reason of ["connecting", "unauthenticated", "syncing"] as const) {
      persistent.mockClear();
      const { unmount } = await mount(reason);
      expect(persistent.mock.calls[0][1], `${reason} is a waiting state, and content IS at risk`)
        .toBe("collab.notSaving.title");
      await unmount();
    }
  });
});
