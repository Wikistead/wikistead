import type { MacroPresence } from "./live-preview/decorations";

// #92 presence: a MacroPresence backed by a Yjs awareness. Kept separate + typed against a minimal
// AwarenessLike so it is unit-testable without the y-protocols runtime. set() publishes an extra
// `macroEdit` field (the macro anchor) ALONGSIDE the existing `user` field — additive, so yCollab's
// cursor sync is untouched; peers() reads remote states carrying it (self excluded, and only entries
// with both a macroEdit anchor and a user); subscribe() rides the awareness "change" event.
export interface AwarenessLike {
  readonly clientID: number;
  setLocalStateField(field: string, value: unknown): void;
  getStates(): Map<number, Record<string, unknown>>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

export function makeMacroPresence(awareness: AwarenessLike): MacroPresence {
  return {
    set(anchor: string | null) {
      try { awareness.setLocalStateField("macroEdit", anchor); } catch { /* awareness gone */ }
    },
    peers() {
      const out: { anchor: string; name: string; color: string }[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // exclude self
        const anchor = state?.["macroEdit"];
        const u = state?.["user"] as { name?: string; color?: string } | undefined;
        if (typeof anchor === "string" && u) out.push({ anchor, name: String(u.name ?? ""), color: String(u.color ?? "#888") });
      });
      return out;
    },
    subscribe(cb: () => void) {
      awareness.on("change", cb);
      return () => awareness.off("change", cb);
    },
  };
}
