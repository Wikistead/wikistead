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

// #502 / ADR-184 slice 2b: the co-occupancy ROSTER for a text-body island. Returns the clientIDs of every
// peer (INCLUDING self) currently publishing the `macroEdit` anchor `anchor` — i.e. everyone editing that
// same island right now. This is exactly the roster the seed-once election (ephemeral-island.ts shouldSeed)
// needs, and its length is the occupancy count the ephemeral-doc spin-up gates on. Read-only over awareness
// (never writes / touches sync / offset / the canonical Y.Text) — same presence-safe contract as the rest
// of this module. Self is INCLUDED (self also publishes its island anchor via macroPresencePublisher), so
// the election ranks self against peers on equal footing.
export function coOccupantClientIDs(awareness: AwarenessLike, anchor: string): number[] {
  const out: number[] = [];
  awareness.getStates().forEach((state, clientID) => {
    if (state?.["macroEdit"] === anchor) out.push(clientID);
  });
  return out;
}

// #502 / ADR-184 slice 2b: is the island at `anchor` CO-OCCUPIED (2+ peers, incl. self)? The ephemeral
// shared doc is spun up ONLY when this is true — a lone editor keeps the plain local-CM path and pays zero
// cost (ADR §3 "single occupant spins up NO ephemeral doc", the common case). Below 2, there is no peer to
// share a live text with, so there is nothing to seed or bind.
export function isIslandCoOccupied(awareness: AwarenessLike, anchor: string): boolean {
  return coOccupantClientIDs(awareness, anchor).length >= 2;
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
