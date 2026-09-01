// @vitest-environment happy-dom
//
// #994 owner ruling, the "compose with #980" clause: #980 (a pre-live grace period) and #994 (a gate
// on there being a real unsent edit) both delay or suppress this toast, and the ruling asks the LATER
// lander to show that a true positive is not delayed by the pair of them.
//
// The interaction is not hypothetical. #980 latched "the connection has been live" on
// `reason === null`, which was sound while `reason` came straight off `notLiveReason`. #994 makes
// `reason` the answer of `toastReason`, which is null whenever there is nothing to SAY — including at
// mount, on every page, on a connection that has never been live. Under the old latch that set
// `hasBeenLive` on the first render of every page and the grace period became unreachable in
// production while `notlive-toast-grace-980.test.ts` (which calls the hook with raw reasons) stayed
// green. The hook takes `live` explicitly now; this file is what measures that the pair still behaves.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotLiveToast, GRACE_MS, toastReason } from "./useNotLiveToast";
import { notify } from "../ui/toast";
import type { NotLiveReason } from "./liveness";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("../ui/toast", () => ({ notify: { persistent: vi.fn(), dismiss: vi.fn() } }));

/** The call sites' exact shape: the gate's answer, plus the connection's own liveness. */
function Harness({ live, reason, unsynced }: { live: boolean; reason: NotLiveReason | null; unsynced: boolean }) {
  useNotLiveToast("notlive:c", toastReason({ canEdit: true, reason, unsynced }), live);
  return null;
}

let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host); });
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

const render = (live: boolean, reason: NotLiveReason | null, unsynced: boolean) =>
  act(() => { root.render(createElement(Harness, { live, reason, unsynced })); });

describe("#994 × #980: the two gates compose", () => {
  it("⚠️ the dangerous direction is delayed by NEITHER gate", () => {
    // A reader who was working normally, lost the socket, and typed. This is the case both tickets
    // exist to protect and the one the ruling names: it must appear with no grace and no wait.
    render(true, null, false); // working normally
    render(false, "connecting", true); // socket dropped, and they typed into it
    expect(notify.persistent, "an edit at risk after a healthy connection must be reported at once")
      .toHaveBeenCalledWith("notlive:c", "collab.notSaving.title", "collab.notSaving.connecting");
  });

  it("⚠️ the grace period is still REACHABLE — #994's gate must not have latched it away", () => {
    // The sequence has to START where production starts, or the defect this guards is unreachable
    // FROM THE TEST as well: the first render of every page is `reason: null` (the gate has nothing
    // to say yet), and it is that null a `hasBeenLive = reason === null` latch would fire on. A
    // version of this case that opened at "syncing" passed the broken latch — measured.
    render(false, "connecting", false); // page open, nothing typed: the gate says nothing
    // Now the reader types before the handshake finishes. True — the edit has not reached the
    // server — but it resolves itself in the 400-670ms #980 measured, so the grace still owns it.
    render(false, "syncing", true);
    act(() => { vi.advanceTimersByTime(GRACE_MS - 1); });
    expect(notify.persistent, "#980's grace has become unreachable code").not.toHaveBeenCalled();
    // …and must still fire if the handshake genuinely never completes.
    act(() => { vi.advanceTimersByTime(1); });
    expect(notify.persistent).toHaveBeenCalledWith("notlive:c", "collab.notSaving.title", "collab.notSaving.syncing");
  });

  it("an ordinary page open says nothing at all, with or without the grace elapsing", () => {
    // #994's own defect. #980 alone narrowed this window; the gate closes it.
    render(false, "connecting", false);
    render(false, "syncing", false);
    act(() => { vi.advanceTimersByTime(GRACE_MS * 2); });
    expect(notify.persistent).not.toHaveBeenCalled();
  });

  it("⚠️ read-only is announced at once — it waits for neither the keystroke nor the grace", () => {
    // Owner ruling ②. `liveness.ts` calls read-only out as the one reason that "is not a waiting
    // state and will not fix itself", so the grace period has nothing to wait for here.
    render(false, "read-only", false);
    expect(notify.persistent).toHaveBeenCalledWith("notlive:c", "collab.notSaving.readOnlyTitle", "collab.notSaving.readOnly");
  });
});
