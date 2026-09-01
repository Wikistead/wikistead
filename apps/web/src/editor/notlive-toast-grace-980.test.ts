// @vitest-environment happy-dom
// #980 (owner ruling, 2026-08-28): the toast used to fire on the connecting → syncing → live
// handshake that normally completes in 400-670ms, flashing on every page open. Fix: a GRACE_MS delay
// before the FIRST-EVER live, and NO grace at all once the editor has been live once (a later
// disconnect is the dangerous direction and must show immediately — §2, accepted §8).
//
// Break-check for §8: removing the pre-live/post-live distinction (grace applied everywhere) makes
// "a disconnect after having been live shows with no delay" go red — see that test below.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotLiveToast, GRACE_MS } from "./useNotLiveToast";
import { notify } from "../ui/toast";
import type { NotLiveReason } from "./liveness";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("../ui/toast", () => ({ notify: { persistent: vi.fn(), dismiss: vi.fn() } }));

// #994 / ADR-276 added a third argument. `live` is the CONNECTION's own answer, which the hook now
// latches "has been live" on — it used to infer that from `reason === null`, and #994's gate can null
// `reason` on a connection that was never live (nothing at risk to report), which would have set the
// latch at mount and made this whole grace period unreachable. Each case below therefore says
// explicitly whether the connection was live, where it used to say it by passing `null`.
function Harness({ id, reason, live }: { id: string; reason: NotLiveReason | null; live: boolean }) {
  useNotLiveToast(id, reason, live);
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host); });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (id: string, reason: NotLiveReason | null, live = false) =>
  act(() => { root.render(createElement(Harness, { id, reason, live })); });

describe("#980: pre-live toast is delayed by a grace period, post-live is not", () => {
  it("a pre-live disconnect that resolves inside the handshake window never toasts", () => {
    render("notlive:p1", "connecting");
    act(() => { vi.advanceTimersByTime(GRACE_MS - 1); });
    expect(notify.persistent).not.toHaveBeenCalled();
    render("notlive:p1", null, true); // synced before the grace period elapsed
    act(() => { vi.advanceTimersByTime(GRACE_MS); });
    expect(notify.persistent).not.toHaveBeenCalled();
  });

  it("a pre-live disconnect that outlasts the grace period toasts once it elapses", () => {
    render("notlive:p2", "connecting");
    act(() => { vi.advanceTimersByTime(GRACE_MS - 1); });
    expect(notify.persistent).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(notify.persistent).toHaveBeenCalledWith("notlive:p2", "collab.notSaving.title", "collab.notSaving.connecting");
  });

  it("bouncing between reasons pre-live does not restart the grace timer (no infinite hiding)", () => {
    render("notlive:p3", "connecting");
    act(() => { vi.advanceTimersByTime(GRACE_MS - 100); });
    render("notlive:p3", "syncing"); // reason changes, but never went live
    act(() => { vi.advanceTimersByTime(100); }); // total elapsed = GRACE_MS from the FIRST non-null reason
    expect(notify.persistent).toHaveBeenCalledWith("notlive:p3", "collab.notSaving.title", "collab.notSaving.syncing");
  });

  it("a disconnect after having been live shows immediately, with no grace", () => {
    render("notlive:p4", null, true); // reaches live first
    render("notlive:p4", "syncing"); // then drops
    // asserted with ZERO timer advance: a mutation that re-applies grace universally leaves this
    // pending and turns this assertion red.
    expect(notify.persistent).toHaveBeenCalledWith("notlive:p4", "collab.notSaving.title", "collab.notSaving.syncing");
  });

  it("going live dismisses any pending pre-live grace timer so it cannot fire late", () => {
    render("notlive:p5", "connecting");
    render("notlive:p5", null, true);
    act(() => { vi.advanceTimersByTime(GRACE_MS * 2); });
    expect(notify.persistent).not.toHaveBeenCalled();
    expect(notify.dismiss).toHaveBeenCalledWith("notlive:p5");
  });

  it("unmount clears a pending grace timer instead of toasting after the component is gone", () => {
    render("notlive:p6", "connecting");
    act(() => { root.unmount(); });
    act(() => { vi.advanceTimersByTime(GRACE_MS * 2); });
    expect(notify.persistent).not.toHaveBeenCalled();
  });
});
