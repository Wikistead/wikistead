import { useSyncExternalStore } from "react";

// An external boolean store for the editor's "unpublished changes" state, used to
// enable Publish the instant an edit diverges from the published snapshot. It lives
// OUTSIDE React state on purpose: the editor WRITES it (from a Y.Text observer)
// without re-rendering itself, and ONLY the publish control SUBSCRIBES — so the
// editor and its host never re-render on a keystroke. This is what keeps it off
// the presence/awareness path (see the editor-dirty-presence-constraint: driving
// this through host React state regressed the presence e2e). The server's persisted
// has_unpublished_changes (via the published poll) stays authoritative; this is an
// optimistic UI enable layered on top.
export interface DirtySignal {
  get(): boolean;
  set(v: boolean): void;
  subscribe(cb: () => void): () => void;
}

export function createDirtySignal(): DirtySignal {
  let value = false;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v) { if (v !== value) { value = v; subs.forEach((s) => s()); } }, // dedup: notify only on a real flip
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}

const NOOP: DirtySignal = { get: () => false, set: () => {}, subscribe: () => () => {} };

// Subscribe to a dirty signal (or a stable no-op when absent, e.g. guests).
export function useDirty(signal?: DirtySignal): boolean {
  const sig = signal ?? NOOP;
  return useSyncExternalStore(sig.subscribe, sig.get, sig.get);
}
