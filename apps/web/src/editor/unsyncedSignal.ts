// #994 / ADR-276: is there a local edit that never reached the collab server?
//
// `liveness.ts` answers a question about the CONNECTION ("are edits arriving"), and the not-live
// toast rendered that answer as a sentence about CONTENT ("your changes are not being saved") —
// including on an ordinary page load, before anything had been typed at all. This is the missing
// half: the predicate the toast should actually have been standing on.
//
// ── Why a latch, and not the provider's own `hasUnsyncedChanges` ────────────────────────────────
//
// The Hocuspocus provider already counts pending updates, and mirroring that counter looks like the
// obvious implementation. It is wrong on three counts, all read out of the provider's source
// (@hocuspocus/provider 2.15.3):
//
//   1. `resetUnsyncedChanges()` assigns `1`, not `0`, and `startSync()` calls it on EVERY socket
//      open. So the counter reads "pending" at the moment of a zero-edit page load — the very
//      false positive this exists to remove, relocated rather than fixed.
//   2. `decrementUnsyncedChanges()` has no floor. A reconnect that flushes queued sends against a
//      counter just reset to `1` can drive it negative, and a strict `n > 0` mirror then reports
//      "nothing pending" forever — fail-open, in the direction of the accident #813 closed.
//   3. The server acks roughly one message per Y.Doc update, so during ordinary live typing the
//      count toggles `0↔1` at keystroke speed. Mirroring that into a `useSyncExternalStore` would
//      re-render the host twice per keystroke — the regression [[editor-dirty-presence-constraint]]
//      already measured (presence e2e 3/3) and the reason `liveness.ts` refuses to render from
//      `hasUnsyncedChanges` in the first place.
//
// So the SET side is driven by the local Y.Doc directly (a doc with no local edits never fires the
// listener, whatever the provider's counter says), the CLEAR side uses the provider's event only as
// an ACK signal (`n <= 0`, not `=== 0`, so the negative drift of (2) still clears), and the value
// anyone outside ever sees is the computed `latch && !live`. That last part is what makes (3)
// impossible rather than unlikely: while the connection is healthy `live` is true, so the exposed
// value is `false` no matter how often the internal latch flips, and no subscriber is notified at
// all.
import { createDirtySignal, type DirtySignal } from "./dirtySignal";
import { useSyncExternalStore } from "react";

/**
 * The external store the toast reads: the same `get`/`set`/`subscribe` shape as `DirtySignal`.
 *
 * They stay two SEPARATE stores on purpose. `dirtySignal` answers "does the draft diverge from the
 * published snapshot", which is true for the whole indefinite life of an unpublished draft — gating
 * "not saved" on it would fire on every brief disconnect for any page with a draft, which is the
 * false alarm in the other direction.
 */
export type UnsyncedSignal = DirtySignal;

export function createUnsyncedSignal(): UnsyncedSignal {
  // The store is `dirtySignal`'s, reused rather than copied: one implementation of the
  // notify-only-on-a-real-flip dedup, which is the property both signals' isolation rests on.
  return createDirtySignal();
}

/** Subscribe to an unsynced signal (or a stable no-op when absent). */
export function useUnsynced(signal?: UnsyncedSignal): boolean {
  return useSyncExternalStore(
    signal?.subscribe ?? NOOP.subscribe,
    signal?.get ?? NOOP.get,
    signal?.get ?? NOOP.get,
  );
}
const NOOP: UnsyncedSignal = { get: () => false, set: () => {}, subscribe: () => () => {} };

/**
 * The transition rule, pure so it can be driven without a socket or a real provider.
 *
 * `onChange` is called ONLY when the computed value actually flips — never on an internal latch
 * move that the AND swallows, which is the whole point (see the header).
 */
export interface UnsyncedLatch {
  /** a local (non-provider-origin) update landed in the Y.Doc */
  noteLocalUpdate(): void;
  /** the provider reported how many of its updates are still unacknowledged */
  noteAck(pending: number): void;
  /** the connection's liveness changed */
  noteLive(live: boolean): void;
  /** the computed `latch && !live` — the only thing outside this module ever sees */
  readonly value: boolean;
}

export function createUnsyncedLatch(onChange: (v: boolean) => void): UnsyncedLatch {
  let latch = false;
  // Both start false, which is also the correct answer on mount: a surface that has not connected
  // yet (a view-only member never calls `connect()` at all) has nothing pending, and must not open
  // by claiming it does.
  let live = false;
  let value = false;
  const recompute = () => {
    const next = latch && !live;
    if (next === value) return; // dedup: the host is notified on a real flip, nothing else
    value = next;
    onChange(value);
  };
  return {
    get value() {
      return value;
    },
    noteLocalUpdate() {
      latch = true;
      recompute();
    },
    noteAck(pending) {
      // `<= 0`, not `=== 0`: the counter has no floor and a reconnect can overshoot past zero.
      // A count that has overshot still means "the server has acknowledged everything".
      if (pending > 0) return;
      latch = false;
      recompute();
    },
    noteLive(next) {
      live = next;
      recompute();
    },
  };
}
